#!/usr/bin/env node
'use strict';
/*
 * ToolMend — repair broken tool calls between an agent client and an
 * Anthropic-compatible LLM backend.
 * https://github.com/AIVerge/ToolMend
 *
 *   agent client  ->  ToolMend (LISTEN)  ->  UPSTREAM (your gateway / vLLM)
 *
 * A transparent reverse proxy: every request/response is forwarded verbatim
 * EXCEPT that /v1/messages responses are repaired when the model emits tool
 * calls the backend failed to parse (DeepSeek "DSML" markup leaking as text),
 * or stalls after announcing a tool call without emitting one.
 *
 * Zero dependencies (Node core only). Node >= 18.
 *
 * Env:
 *   LISTEN_HOST   default 127.0.0.1
 *   LISTEN_PORT   default 29090
 *   UPSTREAM      default http://127.0.0.1:8080
 *   TOOLMEND_LOG  default ./toolmend.log
 *
 * Self test (no network):  node toolmend.js --selftest
 * Probe the detector:      node toolmend.js --probe "text" --loop --tok 40
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');

const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '29090', 10);
const UPSTREAM = new URL(process.env.UPSTREAM || 'http://127.0.0.1:8080');
const LOG_FILE = process.env.TOOLMEND_LOG || process.env.DSML_LOG || './toolmend.log';
// Auto-continue: when the model finishes "thinking" with end_turn but never
// emits the tool call it announced, fire one follow-up request and splice the
// recovered tool call into the same response (cf vllm#36654 thinking->acting break).
const VERSION = '0.1.0';
// Repair counters exposed on /healthz so operators can see it working.
const STATS = { requests: 0, dsmlRepaired: 0, tagsStripped: 0, truncated: 0, continuations: 0, recovered: 0 };
const AUTOCONTINUE = process.env.DSML_AUTOCONTINUE !== '0';
const AUTOCONTINUE_MAX_OUT = parseInt(process.env.DSML_AUTOCONTINUE_MAX_OUT_TOKENS || '15000', 10);
const AUTOCONTINUE_NUDGE = process.env.DSML_AUTOCONTINUE_NUDGE ||
  'Continue. If you were about to call a tool, emit that tool call now. '
  + 'Do not repeat your previous reasoning or explanation.';
// Emit a short, visible in-band marker when we actually splice a recovered tool
// call, so the user can tell an odd-looking turn was caused by the proxy.
const AUTOCONTINUE_MARK = process.env.DSML_AUTOCONTINUE_MARK !== '0';
const AUTOCONTINUE_MARK_TEXT = process.env.DSML_AUTOCONTINUE_MARK_TEXT ||
  '\n\n\u27E6proxy\u27E7 detected a completed thought with no tool call; re-issued it.\n';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  process.stdout.write(line);
}

// Anomaly log: full raw dumps (request + leaked DSML) for post-mortem.
// Kept separate so the main log stays readable and this stays greppable.
const ANOMALY_FILE = process.env.DSML_ANOMALY_LOG || (LOG_FILE.replace(/\.log$/, '') + '.anomaly.log');
function logAnomaly(obj) {
  const rec = Object.assign({ ts: new Date().toISOString() }, obj);
  const line = '===== DSML ANOMALY =====\n' + JSON.stringify(rec, null, 2) + '\n';
  try { fs.appendFileSync(ANOMALY_FILE, line); } catch (_) {}
  log(`ANOMALY reqId=${obj.reqId} model=${obj.model || '?'} calls=${obj.calls} parsed=${obj.parsed} -> ${ANOMALY_FILE}`);
}

function shortId() { return Math.random().toString(36).slice(2, 10); }

// Pause log: EVERY end_turn-with-tools-but-no-toolcall turn is recorded here
// (triggered or not) with its trailing text — the dataset for tuning the
// thinking->acting detector over time.
const PAUSE_FILE = process.env.DSML_PAUSE_LOG || (LOG_FILE.replace(/\.log$/, '') + '.autocontinue.log');
function logPause(obj) {
  const rec = Object.assign({ ts: new Date().toISOString() }, obj);
  try { fs.appendFileSync(PAUSE_FILE, JSON.stringify(rec) + '\n'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// DSML markers (tolerant to fullwidth "｜" U+FF5C, ascii "|", and no prefix)
// ---------------------------------------------------------------------------
// Real leaks observed use <｜DSML｜tool_calls>; the issue examples used
// function_calls. Accept both, with or without the DSML prefix.
const OPEN_MARKERS = [
  /<\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:function_calls|tool_calls)\s*>/i, // <｜DSML｜tool_calls>
  /<\s*(?:function_calls|tool_calls)\s*>/i,                          // <tool_calls>
  /<\s*[｜|]\s*tool[▁_\s]*calls[▁_\s]*begin\s*[｜|]\s*>/i,           // deepseek native begin
  // Bare invoke with no wrapper — observed in production. MUST be parsed into a
  // real tool call, never stripped, or the model's actual call is destroyed.
  /<\s*[｜|]?\s*(?:DSML\s*[｜|]?\s*)?invoke\s+name\s*=\s*"/i,
];
const CLOSE_MARKERS = [
  /<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:function_calls|tool_calls)\s*>/i,
  /<\s*\/\s*(?:function_calls|tool_calls)\s*>/i,
  /<\s*[｜|]\s*tool[▁_\s]*calls[▁_\s]*end\s*[｜|]\s*>/i,
];
// Closing marker used when the block was opened by a bare <invoke …> (no wrapper).
const CLOSE_MARKERS_INVOKE = [
  /<\s*\/\s*[｜|]?\s*(?:DSML\s*[｜|]?\s*)?invoke\s*>/i,
];

// A single DSML tag of any kind (open OR close), e.g. </｜DSML｜parameter>,
// <｜DSML｜invoke name="Bash">, </｜DSML｜tool_calls>. Used to scrub orphan
// closing tags that the backend leaks as plain text after it has already
// parsed the tool calls itself.
const ANY_DSML_TAG = /<\s*\/?\s*[｜|]?\s*(?:DSML\s*[｜|]?\s*)?(?:tool_calls|function_calls|invoke|parameter)\b[^>]*?>/gi;

function normDsml(s) { return s.toLowerCase().replace(/[｜|]/g, '|').replace(/\s+/g, ''); }
const DSML_SKELETONS = [
  '<|dsml|tool_calls>', '<|dsml|function_calls>', '<tool_calls>', '<function_calls>',
  '</|dsml|tool_calls>', '</|dsml|function_calls>', '</tool_calls>', '</function_calls>',
  '<|dsml|invoke', '</|dsml|invoke>', '<invoke', '</invoke>',
  '<|dsml|parameter', '</|dsml|parameter>', '<parameter', '</parameter>',
  '<|tool▁calls▁begin|>', '<|tool_calls_begin|>',
].map(normDsml);

function firstMatch(text, regexes) {
  let best = null;
  for (const re of regexes) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length };
    }
  }
  return best;
}

// Could the tail of `text` be the beginning of an (incomplete) DSML tag of
// any kind (open or close)? If so, return the index of that '<' so we hold it
// back until the next chunk completes (or contradicts) it.
function partialDsmlStart(text) {
  const lt = text.lastIndexOf('<');
  if (lt === -1) return -1;
  const tail = text.slice(lt);
  if (tail.includes('>')) return -1; // already a complete tag, handled elsewhere
  const nt = normDsml(tail);
  for (const sk of DSML_SKELETONS) {
    // Hold when the tail is still a PREFIX of a known tag ("<｜DSM"), and also
    // when it already CONTAINS a known tag opening but has no ">" yet — tags
    // carry attributes (name="…" string="true") and get split across stream
    // chunks, which previously leaked half a tag as visible text.
    if (sk.startsWith(nt) || nt.startsWith(sk)) return lt;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Parse a captured DSML blob into [{name, input}]
// ---------------------------------------------------------------------------
function coerce(value, type) {
  if (type == null) {
    // try JSON, else string
    const t = value.trim();
    if (/^(-?\d+(\.\d+)?|true|false|null|\{[\s\S]*\}|\[[\s\S]*\])$/.test(t)) {
      try { return JSON.parse(t); } catch (_) {}
    }
    return value;
  }
  const t = value.trim();
  try {
    switch (type) {
      case 'number': return Number(t);
      case 'integer': return parseInt(t, 10);
      case 'boolean': return t === 'true' || t === '1';
      case 'object':
      case 'array': return JSON.parse(t);
      case 'string': return value;
      default: return value;
    }
  } catch (_) {
    return value;
  }
}

function parseDsml(blob, toolSchemas) {
  const calls = [];
  // Anthropic-style: <...invoke name="X">  <...parameter name="p">v</...parameter> ...
  const invokeRe = /invoke\s+name\s*=\s*"([^"]+)"\s*>/gi;
  let im;
  const invokeStarts = [];
  while ((im = invokeRe.exec(blob)) !== null) {
    invokeStarts.push({ name: im[1], bodyStart: invokeRe.lastIndex, matchStart: im.index });
  }
  if (invokeStarts.length) {
    for (let i = 0; i < invokeStarts.length; i++) {
      const cur = invokeStarts[i];
      const next = invokeStarts[i + 1];
      const bodyEnd = next ? next.matchStart : blob.length;
      const body = blob.slice(cur.bodyStart, bodyEnd);
      const schema = (toolSchemas && toolSchemas[cur.name] && toolSchemas[cur.name].properties) || {};
      const input = {};
      const paramRe = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\s*\/[^>]*parameter\s*>/gi;
      let pm;
      while ((pm = paramRe.exec(body)) !== null) {
        const pname = pm[1];
        let pval = pm[2];
        // strip a single leading/trailing newline commonly present
        pval = pval.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
        const ptype = schema[pname] && schema[pname].type;
        input[pname] = coerce(pval, ptype);
      }
      calls.push({ name: cur.name, input });
    }
    return calls;
  }

  // Fallback: DeepSeek native json-fenced format
  //   function<｜tool▁sep｜>NAME\n```json\n{...}```
  const nativeRe = /function\s*[｜|]?\s*(?:tool[▁_\s]*sep\s*[｜|]?)?\s*([A-Za-z0-9_.-]+)[\s\S]*?```(?:json)?\s*([\s\S]*?)```/gi;
  let nm;
  while ((nm = nativeRe.exec(blob)) !== null) {
    let input = {};
    try { input = JSON.parse(nm[2].trim()); } catch (_) {}
    calls.push({ name: nm[1], input });
  }
  return calls;
}

// HIGH-PRECISION detector: did the model announce an imminent tool/skill call
// and then stop WITHOUT emitting it? We deliberately favour precision over
// recall — it is fine to miss a halt, but every trigger must be a real one, so
// normal conversation is never auto-continued. Two tight patterns only:
//   (1) the text ends on a dangling colon AND the tail is about calling a tool
//       — e.g. "…我现在先调用技能：" (a complete answer virtually never ends ":")
//   (2) the text is cut off right after an explicit "call/invoke <tool>" phrase
//       with no sentence-ending punctuation.
// Operational (tool-requiring) verbs. Cognitive verbs (解释/分析/介绍/总结/
// think/explain…) are deliberately NOT here, so normal explanatory answers
// never match.
const OP_ZH = /(重写|改写|编写|编辑|修改|创建|新建|生成|写入|写好|写完|保存|运行|执行|调用|加载|更新|删除|实现|构建|读取|查看|搜索|替换|补充|拆分|整理|部署|提交|安装|下载|导出|渲染|固化|落地|生成|输出|新增)/;
const OP_EN = /\b(rewrite|write|edit|modify|create|generate|run|execute|call|invoke|update|delete|implement|build|read|search|replace|refactor|add|save|deploy|commit|install|download|render|output|persist)\b/i;
const TOOLISH = /(技能|工具)/;
const TOOLISH_EN = /\b(skill|tool)\b/i;

function hasActionIntent(clause, toolNames) {
  if (!clause) return false;
  return OP_ZH.test(clause) || OP_EN.test(clause) || TOOLISH.test(clause) || TOOLISH_EN.test(clause)
    || (toolNames || []).some((n) => n && n.length > 1 && clause.includes(n));
}

// ---------------------------------------------------------------------------
// Structural halt detection
//
// Instead of enumerating content words (an OPEN set — "重写/写入/保存/…" can
// never be completed), we score four signals that are independent of wording:
//   A danglingEnd  — the text stops mid-utterance (punctuation/grammar only)
//   B inToolLoop   — the REQUEST shows we're inside an agentic tool loop
//   C shortOutput  — very few output tokens although tools were offered
//   D forwardIntent— first-person forward-looking markers (a CLOSED function-word
//                    set: 我将/接下来/let me/I'll … — no verbs enumerated)
// A halt is declared only on strong combinations, so ordinary prose answers
// (complete sentence, not in a loop) never trigger.
// ---------------------------------------------------------------------------

// A: the utterance is left hanging — no sentence-final punctuation, or it ends
// on a connector (colon/comma/enumeration comma/dash/open bracket).
function endsDangling(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/[：:，,、；;\-—–~/|>·]\s*$/.test(t)) return true;          // connector endings
  if (/[（(\[【「『“"']\s*$/.test(t)) return true;                 // opened, never closed
  if ((t.match(/```/g) || []).length % 2 === 1) return true;       // unclosed code fence
  return !/[。.!！?？…”"'）)】\]}]\s*$/.test(t);                   // no terminal punctuation at all
}

// D: forward-looking first person. Closed set of function words / tense markers
// only — deliberately NO action verbs, so it generalises across phrasings.
// Forward-looking intent markers (closed function-word set, no action verbs).
// English temporal adverbs (now/next/then/first) are POSITION sensitive: they
// only signal intent sentence-initially ("Now let me…") — sentence-final "now"
// means "currently" ("All tests pass now."), so they are anchored.
const FORWARD_INTENT = new RegExp([
  // Chinese intent / temporal markers
  '(我将|我会|我要|我来|我先|我这就|我直接|我准备|我打算|我需要|让我|接下来|下面|首先|然后|第一步|下一步|现在|马上|立刻|这就|随后|紧接着|继续|接着)',
  // English strong markers — valid in any position
  "(\\bi'?ll\\b|\\bi will\\b|\\blet me\\b|\\blet'?s\\b|\\bwe'?ll\\b|\\bi'?m going to\\b|\\bgoing to\\b|\\bgo(ing)? ahead\\b|\\bi'?m about to\\b|\\bcontinu(e|ing)\\b|\\bproceed(ing)?\\b|\\bmoving on\\b|\\bi need to\\b|\\bi should\\b)",
  // English temporal adverbs — only sentence-initial, or right after I'll / let's
  '((^|[.!?;:\\n]\\s*)(now|next|then|first|starting)\\b)',
  "((\\bi'?ll|\\bwe'?ll|\\blet me|\\blet'?s)\\s+(now|then|first)\\b)",
].join('|'), 'i');

// E: is the assistant handing control back to the user (question / request for
// confirmation)? That is a LEGITIMATE end_turn inside an agent loop, so it acts
// as a hard veto. Interrogative punctuation is a closed set; the few solicitation
// phrases are function-word-like ("告诉我", "是否", "shall I").
const SOLICITS_USER = /[？?]\s*$/;
const SOLICIT_PHRASE = /(告诉我|请确认|确认无误|请选择|你想|您想|你更|您更|是否需要|需要我|要不要|如需|请指示|等你|等您|由你|由您)|(\blet me know\b|\bshall i\b|\bshould i\b|\bdo you want\b|\bwould you (like|prefer)\b|\bwhich (one|option|approach)\b|\bplease confirm\b|\byour call\b|\bup to you\b|\bany preference\b|\bsound good\b|\bwant me to\b)/i;
function solicitsUser(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (SOLICITS_USER.test(t)) return true;
  return SOLICIT_PHRASE.test(t.slice(-300));
}

// F: a completion report ("已完成…", "done") is a legitimate way to end a turn.
// Perfective/aspect markers are a closed set. Only vetoes when the turn does NOT
// also announce further work (otherwise "第3篇完成。现在写第4篇…" would be missed).
const COMPLETION_MARK = /(已完成|已经完成|完成了|已修复|已更新|已生成|已写完|已保存|已提交|搞定|全部完成|结束了)|(\b(done|finished|completed|all set|successfully|is complete|are complete|tests? pass(ed|es)?)\b)|(\bi'?ve\b|\bi have\b|\bhas been\b|\bhave been\b)/i;

// B: does the REQUEST itself show an in-flight agentic tool loop? This is the
// strongest wording-independent signal: an assistant that is mid-loop and then
// returns a short plain-text end_turn has almost certainly broken.
// Strictest position signal: the LAST message is a tool_result, i.e. the model
// was invoked specifically to react to a tool it just ran. In that position an
// assistant turn should act, ask, or report done — narrating and stopping is a
// stall. (detectToolLoop below is the looser "a tool was used at some point".)
function detectMidLoop(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return false;
  return last.content.some((b) => b && b.type === 'tool_result');
}

// First-person forward intent: the model says IT is about to do something.
// Clauses addressed to the user ("接下来你可以…", "you can then…") are excluded,
// because those are legitimate hand-offs, not stalls.
function selfForwardIntent(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const clauses = t.split(/[。！？!?\n；;]+/).map((s) => s.trim()).filter(Boolean);
  // Chinese frequently drops the subject ("继续写第 4 篇"), so we do NOT require
  // an explicit "I" — we only rule out clauses addressed to the user.
  return clauses.some((c) => FORWARD_INTENT.test(c) && !/(你|您|\byou\b|\byour\b)/i.test(c));
}

function detectToolLoop(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  let sawToolUse = false, lastIsToolResult = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') sawToolUse = true;
      if (b.type === 'tool_result' && i === messages.length - 1) lastIsToolResult = true;
    }
  }
  return lastIsToolResult || sawToolUse;
}

// Returns {halt:boolean, why:string} — `why` names the signals that fired so the
// decision is auditable in the logs.
function analyzeHalt(text, opts) {
  const o = opts || {};
  const t = (text || '').trim();
  const clauses = t.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const lastClause = clauses.length ? clauses[clauses.length - 1] : t;

  const A = endsDangling(t);                                   // hanging utterance
  const B = !!o.inToolLoop;                                    // agentic loop in flight
  const C = o.outputTokens != null && o.outputTokens < (o.shortOut || 400); // suspiciously short
  // forward intent in the last clause — but not when that clause talks TO the user
  const D = FORWARD_INTENT.test(lastClause) && !/(你|您|\byou\b|\byour\b)/i.test(lastClause);
  const D2 = FORWARD_INTENT.test(t);                           // forward intent anywhere
  const E = solicitsUser(t);                                   // handing control back = legit stop
  const W = hasActionIntent(lastClause, o.toolNames);          // weak auxiliary (word hint)
  // very short turn: in an agent loop a turn is normally an action or something
  // substantive; a couple of tokens of narration means it stalled.
  const V = o.outputTokens != null && o.outputTokens < (o.tinyOut || 120);
  const F = COMPLETION_MARK.test(t) && !D2;                    // pure completion report
  const M = !!o.midLoop;                                       // replying to a tool_result
  const S = selfForwardIntent(t);                              // "I am about to …"

  const sig = [A && 'dangling', B && 'toolloop', M && 'midloop', C && 'short', V && 'tiny',
    D && 'forward', D2 && !D && 'forward-any', S && 'self-forward',
    E && 'solicits', F && 'completed', W && 'actionword']
    .filter(Boolean).join('+');

  // Empty answer while tools were offered: always a break.
  if (!t) return { halt: true, why: 'empty-text' };

  // A hanging utterance is the core structural evidence. Require one corroborating
  // signal so a merely comma-ended sentence in free chat doesn't fire.
  if (A && (B || C || D || W)) return { halt: true, why: sig };

  // Handing control back to the user, or reporting the work as finished, are
  // legitimate ways to end a turn — never auto-continue those.
  if (E || F) return { halt: false, why: sig };

  // Mid tool-loop, a tiny turn that ANNOUNCES work (or is cut off) but never
  // acts. "Tiny" alone is not enough: short past-tense status reports like
  // "Fixed the bug in parser.js." are legitimate and must not be continued.
  if (B && V && (S || A)) return { halt: true, why: sig };

  // Replying directly to a tool_result and saying "I'm going to do X" — but no
  // tool call. Length is irrelevant here: the model may ramble for 900 tokens
  // of planning and still never act. Solicitation/completion already vetoed.
  if (M && S) return { halt: true, why: sig };

  // Complete sentence, but a forward-looking promise made mid tool-loop with a
  // tiny output — e.g. "我将完整重写 generate.js 文件。" inside an agent session.
  if (D && B && C) return { halt: true, why: sig };

  // Announced work anywhere in a short mid-loop turn but never acted — e.g.
  // "现在写第 4 篇 X。这一篇讲 Y。" The forward marker may sit in an earlier
  // sentence, so scan the whole text (E above already excluded real questions).
  if (S && B && C) return { halt: true, why: sig };

  // Same promise outside a loop needs the (weak) action-word hint to qualify.
  if (D && W && C) return { halt: true, why: sig };

  return { halt: false, why: sig || 'none' };
}

function looksLikeIntentToAct(text, toolNames, opts) {
  return analyzeHalt(text, Object.assign({ toolNames }, opts || {})).halt;
}

// ---------------------------------------------------------------------------
// Streaming SSE transformer
// ---------------------------------------------------------------------------
function sseEvent(type, dataObj) {
  return `event: ${type}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

class SseRepair {
  constructor(toolSchemas, emit, ctx) {
    this.toolSchemas = toolSchemas || {};
    this.emit = emit;            // (rawString) => void
    this.ctx = ctx || {};        // { reqId, model, userText }
    this.raw = '';               // buffer of un-split upstream text
    // Output blocks are numbered by US, contiguously from 0. Upstream indices
    // are mapped onto ours, because blocks we swallow (pure-DSML text) or add
    // (repaired tool calls) would otherwise leave gaps, and a client that looks
    // a block up by index then fails with "Content block not found".
    this.outIdx = 0;             // next output index to allocate
    this.upMap = new Map();      // upstream index -> our index
    this.textUpIdx = null;       // upstream index of the deferred text block
    // per active text block
    this.textIdx = null;         // OUR index for the open text block
    this.deferredStart = null;   // upstream's content_block for the deferred text
    this.started = false;        // have we forwarded the text start + any delta
    this.mode = 'text';          // 'text' | 'capture'
    this.pending = '';
    this.dsml = '';
    this.injected = false;
    this.finishReason = null;      // upstream stop_reason (end_turn/max_tokens/tool_use)
    this.outputTokens = null;      // upstream usage.output_tokens
    this.sawToolUse = false;       // did the stream contain any tool_use block?
    this.assistantText = '';       // accumulated visible assistant text (for continuation)
    this.pendingContinuation = false; // holding final events pending an auto-continue
    this._haltCache = null;        // memoised halt verdict (signals + reason)
    this.openKind = 'wrapper';     // which marker opened the current capture
    this.truncatedTool = false;    // stream died mid tool call
    this.heldMessageDelta = null;  // withheld message_delta data
    this.heldMessageStop = null;   // withheld message_stop raw
  }

  push(chunk) {
    this.raw += chunk;
    let sep;
    while ((sep = this.raw.indexOf('\n\n')) !== -1) {
      const block = this.raw.slice(0, sep);
      this.raw = this.raw.slice(sep + 2);
      this._handleBlock(block);
    }
  }

  end() {
    if (this.raw.trim()) this._handleBlock(this.raw);
    this.raw = '';
    // Close any block still open — including one WE opened after a repaired tool
    // call, which upstream will never send a stop for.
    if (this.mode === 'capture' || this.started) this._closeTextBlock();
  }

  _handleBlock(block) {
    // A block is one SSE event: possibly "event: X" + "data: {...}"
    const lines = block.split('\n');
    let evName = null;
    let dataStr = null;
    for (const l of lines) {
      if (l.startsWith('event:')) evName = l.slice(6).trim();
      else if (l.startsWith('data:')) dataStr = (dataStr === null ? '' : dataStr + '\n') + l.slice(5).trim();
    }
    if (dataStr === null) { this.emit(block + '\n\n'); return; }
    let data;
    try { data = JSON.parse(dataStr); } catch (_) { this.emit(block + '\n\n'); return; }
    this._handleEvent(evName || data.type, data, block);
  }

  // Byte-faithful passthrough of the ORIGINAL event; only synthesize when we
  // actually repair something. This guarantees the proxy cannot corrupt a
  // normal (non-DSML) stream.
  _passthrough(raw) { this.emit(raw + '\n\n'); }
  _forward(type, data) { this.emit(sseEvent(type, data)); }

  _handleEvent(type, data, raw) {
    switch (type) {
      case 'content_block_start': {
        if (data.content_block && data.content_block.type === 'text') {
          // defer: it might turn out to be pure DSML and never be shown at all
          this.textUpIdx = data.index;
          this.deferredStart = data.content_block;
          this.textIdx = null;
          this.started = false;
          this.mode = 'text';
          this.pending = '';
          this.dsml = '';
          return;
        }
        if (data.content_block && data.content_block.type === 'tool_use') this.sawToolUse = true;
        {
          const our = this.outIdx++;
          this.upMap.set(data.index, our);
          this._forward('content_block_start', Object.assign({}, data, { index: our }));
        }
        return;
      }
      case 'content_block_delta': {
        if (this.textUpIdx !== null && data.index === this.textUpIdx &&
            data.delta && data.delta.type === 'text_delta') {
          this._onText(data.delta.text || '');
          return;
        }
        {
          const our = this.upMap.get(data.index);
          if (our === undefined) return;  // block was swallowed; never emit an orphan delta
          this._forward('content_block_delta', Object.assign({}, data, { index: our }));
        }
        return;
      }
      case 'content_block_stop': {
        if (this.textUpIdx !== null && data.index === this.textUpIdx) {
          this._closeTextBlock();
          this.textUpIdx = null;
          return;
        }
        {
          const our = this.upMap.get(data.index);
          if (our === undefined) return;  // nothing was opened for it
          this._forward('content_block_stop', { type: 'content_block_stop', index: our });
        }
        return;
      }
      case 'message_delta': {
        if (data.delta && data.delta.stop_reason) this.finishReason = data.delta.stop_reason;
        if (data.usage && typeof data.usage.output_tokens === 'number') this.outputTokens = data.usage.output_tokens;
        if (this.injected && data.delta) { data.delta.stop_reason = 'tool_use'; this.finishReason = 'tool_use'; this._forward('message_delta', data); return; }
        if (this._isContinuationCandidate()) {
          // withhold the terminal events; the server may splice a continuation
          this.pendingContinuation = true;
          this.heldMessageDelta = { data, raw };
          return;
        }
        this._passthrough(raw);
        return;
      }
      case 'message_stop': {
        if (this.pendingContinuation) { this.heldMessageStop = raw; return; }
        this._passthrough(raw);
        return;
      }
      default:
        this._passthrough(raw);
    }
  }

  _isContinuationCandidate() {
    return AUTOCONTINUE
      && this.finishReason === 'end_turn'
      && !this.sawToolUse && !this.injected
      && this.ctx.hasTools
      && (this.outputTokens == null || this.outputTokens < AUTOCONTINUE_MAX_OUT)
      && this._haltVerdict().halt;
  }

  _haltVerdict() {
    if (this.truncatedTool) return { halt: true, why: 'truncated-toolcall' };
    if (!this._haltCache) {
      this._haltCache = analyzeHalt(this.assistantText, {
        toolNames: this.ctx.toolNames,
        inToolLoop: this.ctx.inToolLoop,
        midLoop: this.ctx.midLoop,
        outputTokens: this.outputTokens,
      });
    }
    return this._haltCache;
  }

  // Emit recovered continuation tool calls, then the terminal events. If no
  // calls were recovered, fall back to the original (end_turn) terminal events.
  finalizeContinuation(calls, contText) {
    // Deliberately DROP the continuation's prose: the model almost always
    // repeats the narration it already produced ("现在写第 8 篇 …：" twice),
    // which shows up as duplicated text for the user. Only the recovered tool
    // call is spliced in.
    if (contText && contText.trim()) {
      log(`AUTOCONTINUE reqId=${this.ctx.reqId} dropped ${contText.trim().length} chars of duplicate prose from continuation`);
    }
    if (this.started) { this._forward('content_block_stop', { type: 'content_block_stop', index: this.textIdx }); this.started = false; this.textIdx = null; }
    if (calls && calls.length) {
      if (AUTOCONTINUE_MARK) {
        const midx = this.outIdx++;
        this._forward('content_block_start', { type: 'content_block_start', index: midx, content_block: { type: 'text', text: '' } });
        this._forward('content_block_delta', { type: 'content_block_delta', index: midx, delta: { type: 'text_delta', text: AUTOCONTINUE_MARK_TEXT } });
        this._forward('content_block_stop', { type: 'content_block_stop', index: midx });
      }
      for (const c of calls) {
        const idx = this.outIdx++;
        this._forward('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: 'toolu_cont_' + Math.random().toString(36).slice(2, 14), name: c.name, input: {} } });
        this._forward('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) } });
        this._forward('content_block_stop', { type: 'content_block_stop', index: idx });
      }
      const md = (this.heldMessageDelta && this.heldMessageDelta.data) || { type: 'message_delta', delta: {} };
      md.delta = md.delta || {};
      md.delta.stop_reason = 'tool_use';
      this._forward('message_delta', md);
      this.emit(this.heldMessageStop || sseEvent('message_stop', { type: 'message_stop' }));
    } else {
      this.finalizeOriginal();
    }
    this.pendingContinuation = false;
  }

  // Release the withheld terminal events unchanged (no continuation happened).
  finalizeOriginal() {
    if (this.heldMessageDelta) this._passthrough(this.heldMessageDelta.raw);
    if (this.heldMessageStop) this.emit(this.heldMessageStop + '\n\n');
    else this.emit(sseEvent('message_stop', { type: 'message_stop' }));
    this.pendingContinuation = false;
  }

  // Remove complete orphan DSML tags from a text fragment; log what we stripped.
  _stripStrays(s) {
    if (!s) return s;
    const found = s.match(ANY_DSML_TAG);
    if (!found) return s;
    logAnomaly({
      reqId: this.ctx.reqId, model: this.ctx.model, stream: true,
      note: 'orphan DSML tags stripped from assistant text',
      userText: this.ctx.userText, calls: 0, parsed: false,
      strippedTags: found, rawDsml: s.slice(0, 8000),
    });
    STATS.tagsStripped++;
    log(`DSML orphan tags stripped reqId=${this.ctx.reqId}: ${found.join(' ')}`);
    return s.replace(ANY_DSML_TAG, '');
  }

  _flushText(s) {
    if (!s) return;
    this.assistantText += s;
    if (!this.started) {
      // Allocate OUR next contiguous index for this text block (works both for
      // the deferred upstream block and for text following a repaired call).
      this.textIdx = this.outIdx++;
      this._forward('content_block_start', {
        type: 'content_block_start', index: this.textIdx,
        content_block: this.deferredStart || { type: 'text' },
      });
      this.deferredStart = null;
      this.started = true;
    }
    this._forward('content_block_delta', {
      type: 'content_block_delta',
      index: this.textIdx,
      delta: { type: 'text_delta', text: s },
    });
  }

  _onText(text) {
    if (this.mode === 'capture') {
      this.dsml += text;
      this._maybeFinishCapture();
      return;
    }
    this.pending += text;
    const open = firstMatch(this.pending, OPEN_MARKERS);
    if (open) {
      const before = this.pending.slice(0, open.index);
      this._flushText(this._stripStrays(before));
      this.dsml = this.pending.slice(open.index);
      // a bare <invoke …> block closes on </invoke>, a wrapper on </…tool_calls>
      this.openKind = /^<\s*[｜|]?\s*(?:DSML\s*[｜|]?\s*)?invoke\b/i.test(this.dsml) ? 'invoke' : 'wrapper';
      this.pending = '';
      this.mode = 'capture';
      this._maybeFinishCapture();
      return;
    }
    // No opening block. Scrub any complete orphan DSML tags (leaked closing
    // tags, stray invoke/parameter) that the backend dumped as plain text.
    this.pending = this._stripStrays(this.pending);
    // flush everything except a possible partial DSML-tag tail
    const hold = partialDsmlStart(this.pending);
    if (hold === -1) { this._flushText(this.pending); this.pending = ''; }
    else { this._flushText(this.pending.slice(0, hold)); this.pending = this.pending.slice(hold); }
  }

  _maybeFinishCapture() {
    const close = firstMatch(this.dsml, this.openKind === 'invoke' ? CLOSE_MARKERS_INVOKE : CLOSE_MARKERS);
    if (close) {
      const blob = this.dsml.slice(0, close.index + close.length);
      const rest = this.dsml.slice(close.index + close.length);
      this._emitToolCalls(blob);
      this.dsml = '';
      this.mode = 'text';
      // anything after the close marker is normal text again
      this.pending = '';
      if (rest) this._onText(rest);
    }
  }

  _emitToolCalls(blob) {
    const calls = parseDsml(blob, this.toolSchemas);
    // Always dump the raw leaked blob so the exact DSML format is recoverable.
    logAnomaly({
      reqId: this.ctx.reqId, model: this.ctx.model, stream: true,
      userText: this.ctx.userText, tools: Object.keys(this.toolSchemas || {}),
      calls: calls.length, parsed: calls.length > 0,
      toolNames: calls.map(c => c.name),
      rawDsml: blob.slice(0, 8000),
    });
    if (!calls.length) {
      // couldn't parse -> emit the raw text so nothing is lost
      log(`DSML detected but UNPARSEABLE reqId=${this.ctx.reqId}, passing through as text`);
      this._flushText(blob);
      return;
    }
    STATS.dsmlRepaired++;
    log(`DSML repaired reqId=${this.ctx.reqId}: ${calls.length} tool call(s): ${calls.map(c => c.name).join(', ')}`);
    // close the text block if we already opened one (real text preceded)
    if (this.started) {
      this._forward('content_block_stop', { type: 'content_block_stop', index: this.textIdx });
    }
    this.textIdx = null;
    this.started = false;        // any further text must open a fresh block
    this.deferredStart = null;
    for (const c of calls) {
      const idx = this.outIdx++;
      this._forward('content_block_start', {
        type: 'content_block_start', index: idx,
        content_block: { type: 'tool_use', id: 'toolu_dsml_' + Math.random().toString(36).slice(2, 14), name: c.name, input: {} },
      });
      this._forward('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
      });
      this._forward('content_block_stop', { type: 'content_block_stop', index: idx });
    }
    this.injected = true;
  }

  _closeTextBlock() {
    if (this.mode === 'capture') {
      // Stream ended in the MIDDLE of a tool call — the model was cut off.
      // Emitting a half-parsed call would be worse than none: record it as a
      // structural halt and let auto-continue re-issue the call properly.
      const calls = parseDsml(this.dsml, this.toolSchemas);
      const complete = calls.length && calls.some((c) => c.input && Object.keys(c.input).length);
      if (complete) {
        this._emitToolCalls(this.dsml);
      } else {
        this.truncatedTool = true;
        logAnomaly({
          reqId: this.ctx.reqId, model: this.ctx.model, stream: true,
          note: 'stream ended mid tool call (truncated); deferring to auto-continue',
          userText: this.ctx.userText, calls: calls.length, parsed: false,
          rawDsml: this.dsml.slice(0, 8000),
        });
        STATS.truncated++;
        log(`DSML truncated mid tool call reqId=${this.ctx.reqId}; will auto-continue`);
        // close the visible text block we opened before the truncated call
        if (this.started) {
          this._forward('content_block_stop', { type: 'content_block_stop', index: this.textIdx });
        }
      }
      this.dsml = '';
    } else {
      this._flushText(this.pending);
      this.pending = '';
      if (this.started) {
        this._forward('content_block_stop', { type: 'content_block_stop', index: this.textIdx });
      }
    }
    this.textIdx = null;
    this.started = false;        // block is closed; further text opens a new one
    this.deferredStart = null;
    this.mode = 'text';
  }
}

// ---------------------------------------------------------------------------
// Non-streaming JSON repair
// ---------------------------------------------------------------------------
function repairJsonMessage(bodyBuf, toolSchemas, ctx) {
  ctx = ctx || {};
  let msg;
  try { msg = JSON.parse(bodyBuf.toString('utf8')); } catch (_) { return null; }
  if (!msg || !Array.isArray(msg.content)) return null;
  let changed = false;
  let addedTool = false;
  const out = [];
  for (const block of msg.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const open = firstMatch(block.text, OPEN_MARKERS);
      if (open) {
        const blob = block.text.slice(open.index);
        const calls = parseDsml(blob, toolSchemas);
        logAnomaly({
          reqId: ctx.reqId, model: ctx.model, stream: false,
          userText: ctx.userText, tools: Object.keys(toolSchemas || {}),
          calls: calls.length, parsed: calls.length > 0,
          toolNames: calls.map(c => c.name), rawDsml: blob.slice(0, 8000),
        });
        const before = block.text.slice(0, open.index).trim();
        if (before) out.push({ type: 'text', text: before });
        for (const c of calls) {
          out.push({ type: 'tool_use', id: 'toolu_dsml_' + Math.random().toString(36).slice(2, 14), name: c.name, input: c.input });
        }
        if (calls.length) { changed = true; addedTool = true; continue; }
      }
      // no full block, but strip orphan DSML tags leaked as text
      const stripped = block.text.match(ANY_DSML_TAG);
      if (stripped) {
        logAnomaly({
          reqId: ctx.reqId, model: ctx.model, stream: false,
          note: 'orphan DSML tags stripped from assistant text',
          userText: ctx.userText, calls: 0, parsed: false,
          strippedTags: stripped, rawDsml: block.text.slice(0, 8000),
        });
        const cleaned = block.text.replace(ANY_DSML_TAG, '');
        changed = true;
        if (cleaned.trim()) out.push({ type: 'text', text: cleaned });
        continue;
      }
    }
    out.push(block);
  }
  if (!changed) return null;
  msg.content = out;
  if (addedTool) msg.stop_reason = 'tool_use';
  log(`DSML repaired (non-stream) reqId=${ctx.reqId}: tool_calls=${out.filter(b => b.type === 'tool_use').length} addedTool=${addedTool}`);
  return Buffer.from(JSON.stringify(msg), 'utf8');
}

// ---------------------------------------------------------------------------
// Auto-continue: one non-streaming follow-up request that nudges the model to
// actually emit the tool call it announced. Returns recovered {calls, text}.
// ---------------------------------------------------------------------------
function runContinuation(reqId, reqBody, origHeaders, assistantText, cbRaw) {
  let done = false;
  const cb = (calls, text, err) => { if (done) return; done = true; cbRaw(calls, text, err); };
  let j;
  try { j = JSON.parse(reqBody.toString('utf8')); } catch (e) { return cb(null, null, 'bad request json'); }
  const messages = Array.isArray(j.messages) ? j.messages.slice() : [];
  if (assistantText && assistantText.trim()) messages.push({ role: 'assistant', content: assistantText });
  messages.push({ role: 'user', content: AUTOCONTINUE_NUDGE });
  const body = {
    model: j.model, messages, tools: j.tools, tool_choice: j.tool_choice,
    system: j.system, stream: false,
    max_tokens: Math.min(j.max_tokens || 4096, 8192),
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  const headers = { 'content-type': 'application/json', host: UPSTREAM.host };
  for (const h of ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta']) {
    if (origHeaders[h]) headers[h] = origHeaders[h];
  }
  headers['content-length'] = Buffer.byteLength(payload);

  const toolSchemas = {};
  if (Array.isArray(j.tools)) for (const t of j.tools) if (t && t.name) toolSchemas[t.name] = t.input_schema || t.inputSchema || {};

  const r = http.request({
    protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80,
    method: 'POST', path: '/v1/messages', headers,
  }, (up) => {
    const bufs = [];
    up.on('data', (c) => bufs.push(c));
    up.on('end', () => {
      let m;
      try { m = JSON.parse(Buffer.concat(bufs).toString('utf8')); } catch (e) { return cb(null, null, 'bad continuation json'); }
      const calls = []; let text = '';
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_use') calls.push({ name: b.name, input: b.input || {} });
          else if (b && b.type === 'text' && typeof b.text === 'string') {
            const open = firstMatch(b.text, OPEN_MARKERS);
            if (open) {
              for (const c of parseDsml(b.text.slice(open.index), toolSchemas)) calls.push(c);
              text += b.text.slice(0, open.index).replace(ANY_DSML_TAG, '');
            } else {
              text += b.text.replace(ANY_DSML_TAG, '');
            }
          }
        }
      }
      cb(calls, text, null);
    });
    up.on('error', (e) => cb(null, null, e.message));
  });
  r.on('error', (e) => cb(null, null, e.message));
  r.setTimeout(120000, () => { r.destroy(); cb(null, null, 'continuation timeout'); });
  r.write(payload); r.end();
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------
function startServer() {
  let inFlight = 0;
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    inFlight++;
    res.on('close', () => {
      inFlight--;
      if (shuttingDown && inFlight === 0) { log('graceful shutdown: all requests drained'); process.exit(0); }
    });
    // Local health endpoint (never forwarded upstream) — used by the installer,
    // systemd and monitoring to verify ToolMend is live and where it points.
    if (req.url === '/healthz' || req.url === '/__toolmend/health') {
      const body = JSON.stringify({
        ok: true, service: 'toolmend', version: VERSION,
        upstream: UPSTREAM.origin, inFlight, uptimeSec: Math.round(process.uptime()),
        autocontinue: AUTOCONTINUE, repairs: STATS,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks);
      const reqId = shortId();
      const startedAt = Date.now();
      let toolSchemas = {};
      const ctx = { reqId, model: null, userText: null, hasTools: false, toolNames: [], inToolLoop: false, midLoop: false };
      const isMessages = req.url.startsWith('/v1/messages');
      let streamReq = false;
      if (isMessages && reqBody.length) {
        try {
          const j = JSON.parse(reqBody.toString('utf8'));
          ctx.model = j.model || null;
          streamReq = !!j.stream;
          if (Array.isArray(j.tools)) {
            for (const t of j.tools) {
              if (t && t.name) toolSchemas[t.name] = t.input_schema || t.inputSchema || {};
            }
          }
          ctx.inToolLoop = detectToolLoop(j.messages);
          ctx.midLoop = detectMidLoop(j.messages);
          // last user message (truncated) — helps reproduce the anomaly later
          if (Array.isArray(j.messages)) {
            for (let i = j.messages.length - 1; i >= 0; i--) {
              const m = j.messages[i];
              if (m && m.role === 'user') {
                ctx.userText = (typeof m.content === 'string' ? m.content
                  : JSON.stringify(m.content)).slice(0, 500);
                break;
              }
            }
          }
        } catch (_) {}
      }
      ctx.toolNames = Object.keys(toolSchemas);
      ctx.hasTools = ctx.toolNames.length > 0;
      STATS.requests++;
      log(`REQ reqId=${reqId} ${req.method} ${req.url} model=${ctx.model || '-'} stream=${streamReq} tools=${Object.keys(toolSchemas).length} bytes=${reqBody.length}`);

      // Detect the client (claude code) hanging up mid-stream so an "abnormal
      // interruption" on the user's side is visible in the log instead of silent.
      let clientAborted = false;
      res.on('close', () => {
        if (!res.writableFinished) {
          clientAborted = true;
          log(`CLIENT ABORTED reqId=${reqId} ms=${Date.now() - startedAt} (claude code closed the connection before the stream finished)`);
          if (typeof upReq !== 'undefined' && upReq.destroy) upReq.destroy();
        }
      });
      res.on('error', (e) => log(`RES socket error reqId=${reqId}: ${e.message}`));

      const headers = Object.assign({}, req.headers);
      delete headers['accept-encoding']; // avoid gzip so we can read/transform
      headers['host'] = UPSTREAM.host;
      if (reqBody.length) headers['content-length'] = Buffer.byteLength(reqBody);

      const upReq = http.request({
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || 80,
        method: req.method,
        path: req.url,
        headers,
      }, (upRes) => {
        const ct = (upRes.headers['content-type'] || '').toLowerCase();
        const isSse = ct.includes('text/event-stream');
        const isJson = ct.includes('application/json');

        if (isMessages && isSse) {
          const outHeaders = Object.assign({}, upRes.headers);
          delete outHeaders['content-length'];
          delete outHeaders['content-encoding'];
          res.writeHead(upRes.statusCode, outHeaders);
          const safeWrite = (s) => { if (!clientAborted && !res.writableEnded) { try { res.write(s); } catch (_) {} } };
          const repair = new SseRepair(toolSchemas, safeWrite, ctx);
          upRes.setEncoding('utf8');
          upRes.on('data', (c) => repair.push(c));
          upRes.on('end', () => {
            repair.end();
            const finish = (contInfo) => {
              if (!res.writableEnded) res.end();
              const toolish = repair.sawToolUse || repair.injected;
              log(`RES reqId=${reqId} sse status=${upRes.statusCode} repaired=${repair.injected ? 'YES' : 'no'} stop=${repair.finishReason || '?'} out_tok=${repair.outputTokens != null ? repair.outputTokens : '?'} tool=${toolish ? 'yes' : 'no'} ms=${Date.now() - startedAt}${contInfo ? ' ' + contInfo : ''}${clientAborted ? ' (client had aborted)' : ''}`);
              // Record EVERY pause (end_turn + tools available + no tool call),
              // whether or not the detector fired — this is the tuning dataset.
              if (streamReq && !repair.sawToolUse && repair.finishReason === 'end_turn' && ctx.hasTools) {
                logPause({
                  reqId, model: ctx.model, out_tok: repair.outputTokens,
                  triggered: contInfo != null,       // autocontinue fired iff we ran the continuation branch
                  outcome: contInfo || 'not-triggered',
                  signals: repair._haltVerdict().why, // which structural signals fired
                  inToolLoop: ctx.inToolLoop, midLoop: ctx.midLoop,
                  userText: ctx.userText,
                  tail: (repair.assistantText || '').slice(-1000),
                });
              }
            };
            if (repair.pendingContinuation && !clientAborted) {
              STATS.continuations++;
              log(`AUTOCONTINUE reqId=${reqId} thinking->acting break (stop=end_turn tool=no out_tok=${repair.outputTokens} signals=${repair._haltVerdict().why} loop=${ctx.inToolLoop}); firing 1 continuation`);
              runContinuation(reqId, reqBody, req.headers, repair.assistantText, (calls, text, err) => {
                if (err) { log(`AUTOCONTINUE reqId=${reqId} failed: ${err}; fallback to original end_turn`); repair.finalizeOriginal(); finish('cont=failed'); return; }
                if (calls && calls.length) { STATS.recovered += calls.length; log(`AUTOCONTINUE reqId=${reqId} recovered ${calls.length} tool call(s): ${calls.map(c => c.name).join(',')}`); repair.finalizeContinuation(calls, text); finish('cont=recovered:' + calls.length); }
                else { log(`AUTOCONTINUE reqId=${reqId} no tool recovered; fallback`); repair.finalizeContinuation([], null); finish('cont=none'); }
              });
            } else {
              if (repair.pendingContinuation) repair.finalizeOriginal();
              finish(null);
            }
          });
          upRes.on('error', (e) => { log(`upstream stream error reqId=${reqId}: ${e.message}`); if (!res.writableEnded) res.end(); });
          return;
        }

        if (isMessages && isJson) {
          const buf = [];
          upRes.on('data', (c) => buf.push(c));
          upRes.on('end', () => {
            const body = Buffer.concat(buf);
            let outBody = body;
            const repaired = repairJsonMessage(body, toolSchemas, ctx);
            if (repaired) outBody = repaired;
            const outHeaders = Object.assign({}, upRes.headers);
            outHeaders['content-length'] = Buffer.byteLength(outBody);
            delete outHeaders['content-encoding'];
            res.writeHead(upRes.statusCode, outHeaders);
            res.end(outBody);
            log(`RES reqId=${reqId} json status=${upRes.statusCode} repaired=${repaired ? 'YES' : 'no'} ms=${Date.now() - startedAt}`);
          });
          upRes.on('error', () => res.end());
          return;
        }

        // pure passthrough
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => log(`RES reqId=${reqId} passthrough status=${upRes.statusCode} ms=${Date.now() - startedAt}`));
      });

      upReq.on('error', (e) => {
        log('upstream error:', e.message);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
      });

      if (reqBody.length) upReq.write(reqBody);
      upReq.end();
    });
  });

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log(`ToolMend listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM.origin}`);
  });

  // Graceful shutdown: never cut off a live stream on restart. Stop accepting
  // new connections, let in-flight requests finish, then exit.
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} received: draining ${inFlight} in-flight request(s), no longer accepting new ones`);
    server.close(() => { log('graceful shutdown: listener closed'); process.exit(0); });
    if (inFlight === 0) { log('graceful shutdown: nothing in flight'); process.exit(0); }
    // hard cap so a stuck stream can't block a restart forever
    setTimeout(() => { log(`graceful shutdown: timeout with ${inFlight} still in flight; exiting`); process.exit(0); }, 300000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------
function selftest() {
  let ok = true;
  const assert = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) ok = false; };

  // 1. streaming: text then leaked DSML tool call
  {
    const schemas = { glob: { properties: { pattern: { type: 'string' } } } };
    const out = [];
    const r = new SseRepair(schemas, (s) => out.push(s));
    const stream = [
      sseEvent('message_start', { type: 'message_start', message: { content: [] } }),
      sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me search. ' } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<｜DSML｜function_calls>\n<｜DSML｜invoke name="glob">\n' } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<｜DSML｜parameter name="pattern">**/starship.toml</｜DSML｜parameter>\n' } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '</｜DSML｜invoke>\n</｜DSML｜function_calls>' } }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'stop' } }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ].join('');
    r.push(stream); r.end();
    const joined = out.join('');
    assert(/"type":"tool_use"[\s\S]*"name":"glob"/.test(joined), 'stream: tool_use emitted');
    assert(/\*\*\/starship\.toml/.test(joined), 'stream: parameter captured');
    assert(/"stop_reason":"tool_use"/.test(joined), 'stream: stop_reason rewritten');
    assert(/Let me search\./.test(joined), 'stream: preceding text preserved');
    assert(!/DSML/.test(joined), 'stream: no raw DSML leaked');
  }

  // 1b. REAL leak format: <｜DSML｜tool_calls> with a Bash command, split across chunks
  {
    const schemas = { Bash: { properties: { command: { type: 'string' } } } };
    const out = [];
    const r = new SseRepair(schemas, (s) => out.push(s), { reqId: 't1b' });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    const parts = [
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="Bash">\n',
      '<｜DSML｜parameter name="command">soffice --headless --convert-to pdf x.docx',
      '</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
    ];
    for (const p of parts) r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'stop' } }));
    r.end();
    const joined = out.join('');
    assert(/"type":"tool_use"[\s\S]*"name":"Bash"/.test(joined), 'real-leak: Bash tool_use emitted');
    assert(/soffice --headless/.test(joined), 'real-leak: command param captured across chunks');
    assert(/"stop_reason":"tool_use"/.test(joined), 'real-leak: stop_reason rewritten');
    assert(!/DSML/.test(joined), 'real-leak: no raw DSML leaked');
  }

  // 1c. ORPHAN closing tags leaked as text after tools already ran (this bug)
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1c' });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me verify the PDF.\n' } }));
    // leaked orphan closes, split awkwardly across chunks
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '</｜DSML｜para' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'meter>\n</｜DSML｜invoke>\n</｜DSML' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '｜tool_calls>' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    r.end();
    const joined = out.join('');
    assert(/Let me verify the PDF\./.test(joined), 'orphan: real text preserved');
    assert(!/DSML/.test(joined), 'orphan: no DSML leaked (split across chunks)');
    assert(!/"stop_reason":"tool_use"/.test(joined), 'orphan: stop_reason NOT falsely rewritten');
  }

  // 1d. AUTO-CONTINUE: thinking ended with end_turn + no tool, then spliced call
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1d', hasTools: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will call the skill: ' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5000 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    let joined = out.join('');
    assert(r.pendingContinuation === true, 'autocont: candidate detected & terminal events withheld');
    assert(!/message_stop/.test(joined), 'autocont: message_stop withheld until continuation');
    // server would call this after the follow-up request recovered a tool call
    r.finalizeContinuation([{ name: 'Skill', input: { name: 'brainstorming' } }], null);
    joined = out.join('');
    assert(/"type":"tool_use"[\s\S]*"name":"Skill"/.test(joined), 'autocont: recovered tool_use spliced in');
    assert(/brainstorming/.test(joined), 'autocont: recovered tool input present');
    assert(/"stop_reason":"tool_use"/.test(joined), 'autocont: final stop_reason=tool_use');
    assert(/message_stop/.test(joined), 'autocont: message_stop emitted after splice');
  }

  // 1d2. continuation prose must NOT be echoed back (caused duplicated text)
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1d2', hasTools: true, inToolLoop: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '现在写第 8 篇 TLS：' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    // continuation returns the SAME narration plus the tool call
    r.finalizeContinuation([{ name: 'Write', input: { path: 'a.md' } }], '现在写第 8 篇 TLS：');
    const joined = out.join('');
    const occurrences = (joined.match(/现在写第 8 篇 TLS/g) || []).length;
    assert(occurrences === 1, `no-dup: narration appears once (was ${occurrences})`);
    assert(/"name":"Write"/.test(joined), 'no-dup: tool call still spliced');
  }

  // 1e. AUTO-CONTINUE fallback: continuation recovered nothing -> original end_turn
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1e', hasTools: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '让我先调用工具：' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4000 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    assert(r.pendingContinuation === true, 'autocont-fallback: intent text is a candidate');
    r.finalizeOriginal();
    const joined = out.join('');
    assert(/"stop_reason":"end_turn"/.test(joined), 'autocont-fallback: original end_turn restored');
    assert(/message_stop/.test(joined), 'autocont-fallback: message_stop emitted');
  }

  // 1e2. OVER-TRIGGER GUARD: normal prose answer with tools -> NOT a candidate
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1e2', hasTools: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'TCP 是一种面向连接的可靠传输协议。' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 21 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    assert(r.pendingContinuation === false, 'over-trigger guard: normal answer is NOT a candidate');
    assert(/message_stop/.test(out.join('')), 'over-trigger guard: normal answer passes through');
  }

  // 1e3. STRUCTURAL detector: signals, not a word list.
  {
    // agentic context (claude code): in a tool loop, short output
    const mk = (txt, opts) => analyzeHalt(txt, Object.assign(
      { toolNames: ['Bash', 'Skill'], inToolLoop: true, outputTokens: 50 }, opts || {})).halt;
    // free chat context: not in a loop
    const chat = (txt, tok) => analyzeHalt(txt, { toolNames: ['Bash'], inToolLoop: false, outputTokens: tok == null ? 60 : tok }).halt;

    // --- real halts observed in production (all must fire) ---
    assert(mk('继续写 design doc。按 brainstorming 流程，我把设计固化为 spec 文件。\n\n写入 spec：') === true, 'struct: "写入 spec：" halt');
    assert(mk('我先调用技能：') === true, 'struct: "先调用技能：" halt');
    assert(mk('工作量较大。我将完整重写 generate.js 文件。') === true, 'struct: period-ended promise in tool loop halt');
    assert(mk('Let me call the Bash tool') === true, 'struct: cut-off english call halt');
    assert(mk('') === true, 'struct: empty output halt');
    // --- generalisation: verbs never enumerated anywhere ---
    assert(mk('接下来我要给这些图片做去重和归档，') === true, 'struct: unseen verbs + comma ending halt');
    assert(mk('现在我来 hexdump 一下这个二进制头部：') === true, 'struct: unknown verb + colon halt');
    assert(mk('下一步，把 CRD 灰度到预发集群') === true, 'struct: no terminal punctuation halt');
    assert(mk('```python\nprint(1)') === true, 'struct: unclosed code fence halt');

    // --- normal conversation must NEVER fire ---
    assert(chat('TCP 是一种面向连接的可靠传输协议。') === false, 'struct: normal answer no halt');
    assert(chat('我将为你详细解释这个概念。') === false, 'struct: cognitive promise no halt');
    assert(chat('我将介绍三种排序算法。') === false, 'struct: cognitive promise 2 no halt');
    assert(chat('我会尽力帮助你完成任务。') === false, 'struct: polite closer no halt');
    assert(chat('三种方案的区别如下：', 800) === false, 'struct: "区别如下：" long answer no halt');
    assert(chat('原因有以下几点：', 900) === false, 'struct: "原因有以下几点：" long answer no halt');
    assert(chat('你好！有什么可以帮你的吗？') === false, 'struct: greeting no halt');

    // keep the streaming-level behaviour check too
    const mkStream = (txt) => {
      const out = [];
      const r = new SseRepair({}, (s) => out.push(s), { reqId: 'p', hasTools: true, toolNames: ['Bash', 'Skill'], inToolLoop: true });
      r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
      r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: txt } }));
      r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
      r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }));
      r.push(sseEvent('message_stop', { type: 'message_stop' }));
      r.end();
      return r.pendingContinuation;
    };
    assert(mkStream('写入 spec：') === true, 'struct: end-to-end stream halt detected');
    // --- real dataset case foc4ncta: announced work in an EARLIER sentence,
    //     complete sentences, mid tool loop, 49 tokens, never acted -> halt
    assert(analyzeHalt('现在写第 4 篇 **工具调用 Tool Use**。这一篇讲 tools 定义、tool_choice、tool_use/tool_result 循环、多工具。这是协议系列里对集成方最关键的一篇。',
      { inToolLoop: true, outputTokens: 49, toolNames: ['Write'] }).halt === true, 'struct: foc4ncta (announced-not-acted) halt');
    // --- real dataset case mvu4vl0x: asks the user to confirm -> legitimate stop
    assert(analyzeHalt('核心要点：\n- 10 篇篇目\n- 风格沿用技术手册\n\n如果确认无误，我就进入实施阶段；如需调整篇目或细节，直接告诉我。',
      { inToolLoop: true, outputTokens: 276, toolNames: ['Write'] }).halt === false, 'struct: mvu4vl0x (asks user) NO halt');
    // --- real dataset case meinmvnl: 11-token narration mid-loop -> halt
    assert(analyzeHalt('继续写第 4 篇工具调用。', { inToolLoop: true, outputTokens: 11, toolNames: ['Write'] }).halt === true, 'struct: meinmvnl (tiny narration) halt');
    // completion reports mid-loop are NOT halts (closed-set aspect markers)
    assert(analyzeHalt('已完成第 4 篇的写作和校对。', { inToolLoop: true, outputTokens: 30, toolNames: ['Write'] }).halt === false, 'struct: completion report no halt');
    assert(analyzeHalt('全部完成。', { inToolLoop: true, outputTokens: 5, toolNames: ['Write'] }).halt === false, 'struct: tiny completion report no halt');
    assert(analyzeHalt('已修复该 bug，测试通过。', { inToolLoop: true, outputTokens: 18, toolNames: ['Bash'] }).halt === false, 'struct: fix report no halt');
    // but completion + announcing MORE work is still a halt
    assert(analyzeHalt('第 3 篇完成。现在写第 4 篇。', { inToolLoop: true, outputTokens: 20, toolNames: ['Write'] }).halt === true, 'struct: completion + next announcement halt');
    // outside a tool loop a tiny answer is fine
    assert(analyzeHalt('好的。', { inToolLoop: false, outputTokens: 3, toolNames: ['Bash'] }).halt === false, 'struct: tiny answer outside loop no halt');
    // explicit question mid-loop is not a halt
    assert(analyzeHalt('我需要先确认一下：你希望用 A 方案还是 B 方案？', { inToolLoop: true, outputTokens: 40, toolNames: ['Write'] }).halt === false, 'struct: question mid-loop no halt');

    // --- real case 3zsrdo2n: 870-token planning ramble right after a tool
    //     result, announces "I'll rewrite it in Python" but never acts -> halt
    assert(analyzeHalt('综合判断：需要确认参数是否传到了 puppeteer.launch。让我看 index.js 附近那个函数的定义和调用点。\n\n让我直接检查：navigate 期间是否出现 Chrome 进程。这是最稳妥的。我用 Python 写一个健壮的 MCP 客户端。\n\n我用 Python 重写验证脚本，它会自动应答 server 发来的任何 JSON-RPC 请求，从而保证协议正常推进。',
      { inToolLoop: true, midLoop: true, outputTokens: 870, toolNames: ['Bash', 'Read'] }).halt === true,
      'struct: 3zsrdo2n (long ramble after tool_result) halt');
    // --- real case b736xh6p: 680-token summary addressed to the USER -> no halt
    assert(analyzeHalt('已完成配置。\n\n**接下来你可以：**\n- 重启会话后，让我"打开某个网页并截图"\n- 若之后想移除：claude mcp remove chrome-devtools\n\n需要我帮你做点什么来验证，或者调整成 --isolated 之类的启动参数吗？',
      { inToolLoop: true, midLoop: true, outputTokens: 680, toolNames: ['Bash'] }).halt === false,
      'struct: b736xh6p (summary to user) NO halt');
    // second-person guidance after a tool result is a hand-off, not a stall
    assert(analyzeHalt('配置写好了。接下来你可以直接运行 npm test 看结果。',
      { inToolLoop: true, midLoop: true, outputTokens: 300, toolNames: ['Bash'] }).halt === false,
      'struct: second-person handoff NO halt');
    // long English planning after a tool result that never acts -> halt
    assert(analyzeHalt("The config looks wrong in three places. I'll rewrite the validation script in Python so it answers every JSON-RPC request automatically, which rules out a protocol stall.",
      { inToolLoop: true, midLoop: true, outputTokens: 900, toolNames: ['Bash'] }).halt === true,
      'struct: english long ramble after tool_result halt');

    // --- ENGLISH parity: halts must fire, legitimate endings must not ---
    const en = (txt) => analyzeHalt(txt, { inToolLoop: true, outputTokens: 40, toolNames: ['Write', 'Bash'] }).halt;
    ['Now let me write the fourth chapter.', "I'll continue writing part 4.",
     'Continuing with the TLS chapter.', 'Let me now update the config:',
     "Next, I'll refactor the parser", 'Proceeding to generate the PDF.',
     'Moving on to the deployment step.', 'I need to update the schema first.',
     "Let's write the spec file.", "I'll go ahead and create the file."]
      .forEach((s) => assert(en(s) === true, `en-halt: ${s}`));
    ['All 12 tests pass now.', 'The first test passed.',
     "I've updated the config and all tests pass.", 'Fixed the bug in parser.js.',
     'Successfully created 3 files.', 'The refactor is complete.',
     'Wrote the new spec and committed it.', 'Would you like me to proceed with option B?',
     'TCP is a connection-oriented protocol.', 'The file has been saved.',
     "That's the whole flow, then."]
      .forEach((s) => assert(en(s) === false, `en-ok: ${s}`));

    // more real-world halts (agentic context)
    assert(mk('好的，我现在先调用 Skill 技能：') === true, 'struct: intent+colon halt');
    assert(mk('我会先修改配置，然后重新生成 PDF。') === true, 'struct: period-ended plan halt');
    assert(mk("I'll now rewrite generate.js completely.") === true, 'struct: english promise halt');
    assert(mk('现在保存文件：') === true, 'struct: "保存文件：" halt');
    assert(mk('提交 git：') === true, 'struct: "提交 git：" halt');
    // in free chat these complete sentences must stay silent
    assert(chat('这个技能很有用，值得学习。') === false, 'struct: "技能" in prose no halt');
    assert(chat('让我来帮你分析一下。') === false, 'struct: "让我…分析。" no halt');
    assert(chat('接下来我们一起加油。') === false, 'struct: friendly closer no halt');
    assert(chat('我已经改完了配置。总结如下：', 700) === false, 'struct: "总结如下：" long answer no halt');
  }

  // 1f. no tools available -> NOT a continuation candidate (plain end_turn passes)
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s), { reqId: 't1f', hasTools: false });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi.' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    assert(r.pendingContinuation === false, 'no-tools: not a continuation candidate');
    assert(/message_stop/.test(out.join('')), 'no-tools: stream passed through normally');
  }

  // 1g. BARE <invoke> with no wrapper must be PARSED (not stripped away)
  {
    const schemas = { Write: { properties: { path: { type: 'string' }, content: { type: 'string' } } } };
    const out = [];
    const r = new SseRepair(schemas, (s) => out.push(s), { reqId: 't1g', hasTools: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '现在写第 4 篇：\n\n<invoke name="Write">\n<parameter name="path">a.md</parameter>\n<parameter name="content">hello</parameter>\n</invoke>' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    r.end();
    const joined = out.join('');
    assert(/"type":"tool_use"[\s\S]*"name":"Write"/.test(joined), 'bare-invoke: parsed into tool_use (not stripped)');
    assert(/hello/.test(joined) && /a\.md/.test(joined), 'bare-invoke: parameters preserved');
    assert(/"stop_reason":"tool_use"/.test(joined), 'bare-invoke: stop_reason rewritten');
  }

  // 1h. TRUNCATED mid tool call -> no broken call emitted, halt declared
  {
    const schemas = { Write: { properties: { content: { type: 'string' } } } };
    const out = [];
    const r = new SseRepair(schemas, (s) => out.push(s), { reqId: 't1h', hasTools: true });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '现在写第 4 篇：\n\n<invoke name="Write">\n<parameter name="content">Anthropic Messages API' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 70 } }));
    r.push(sseEvent('message_stop', { type: 'message_stop' }));
    r.end();
    const joined = out.join('');
    assert(r.truncatedTool === true, 'truncated: detected mid-tool-call cutoff');
    assert(!/"type":"tool_use"/.test(joined), 'truncated: no broken tool_use emitted');
    assert(r._haltVerdict().halt === true, 'truncated: declared a halt (auto-continue will retry)');
    assert(r.pendingContinuation === true, 'truncated: continuation withheld terminal events');
  }

  // 1i. TEXT AFTER a DSML block must open a NEW valid block.
  // Regression: emitting a delta with index=null (or re-opening a stopped block)
  // corrupts the stream and the client fails with "Content block not found".
  {
    const schemas = { glob: { properties: { pattern: { type: 'string' } } } };
    const out = [];
    const r = new SseRepair(schemas, (s) => out.push(s), { reqId: 't1i' });
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me search. <｜DSML｜tool_calls><｜DSML｜invoke name="glob"><｜DSML｜parameter name="pattern">*.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls> trailing text here' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.end();
    const j = out.join('');
    assert(!/"index":null/.test(j), 'sse-valid: no delta with null index');
    const starts = (j.match(/"type":"content_block_start"/g) || []).length;
    const stops = (j.match(/"type":"content_block_stop"/g) || []).length;
    assert(starts === stops, `sse-valid: starts(${starts}) match stops(${stops})`);
    // every delta index must have been started
    const started = new Set();
    for (const m of j.matchAll(/"type":"content_block_start","index":(\d+)/g)) started.add(m[1]);
    let orphanDelta = false;
    for (const m of j.matchAll(/"type":"content_block_delta","index":(\d+|null)/g)) if (!started.has(m[1])) orphanDelta = true;
    assert(!orphanDelta, 'sse-valid: every delta references a started block');
    assert(/trailing text here/.test(j), 'sse-valid: trailing text preserved');
  }

  // 1j. STREAM WELL-FORMEDNESS across every repair path.
  // Validates the invariant claude code relies on: block indices start at 0,
  // are contiguous, each is started before use and stopped exactly once.
  {
    const validate = (raw, name) => {
      const events = raw.split('\n\n').filter((b) => b.includes('data:'));
      const open = new Set(); const seen = new Set(); let next = 0; const errs = [];
      for (const b of events) {
        const line = b.split('\n').find((l) => l.startsWith('data:'));
        let d; try { d = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (d.type === 'content_block_start') {
          if (d.index !== next) errs.push(`start index ${d.index} != expected ${next}`);
          if (seen.has(d.index)) errs.push(`index ${d.index} started twice`);
          open.add(d.index); seen.add(d.index); next++;
        } else if (d.type === 'content_block_delta') {
          if (!open.has(d.index)) errs.push(`delta for unopened/closed index ${d.index}`);
        } else if (d.type === 'content_block_stop') {
          if (!open.has(d.index)) errs.push(`stop for unopened index ${d.index}`);
          open.delete(d.index);
        }
      }
      if (open.size) errs.push(`unclosed blocks: ${[...open]}`);
      assert(errs.length === 0, `wellformed[${name}]: ${errs.join('; ') || 'ok'}`);
    };

    const run = (deltas, opts) => {
      const out = [];
      const r = new SseRepair({ glob: { properties: { pattern: { type: 'string' } } }, Write: { properties: { path: {} } } },
        (s) => out.push(s), { reqId: 'wf', hasTools: true, inToolLoop: true });
      r.push(sseEvent('message_start', { type: 'message_start', message: { content: [] } }));
      r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
      for (const d of deltas) r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } }));
      r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
      r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: (opts && opts.stop) || 'end_turn' }, usage: { output_tokens: 50 } }));
      r.push(sseEvent('message_stop', { type: 'message_stop' }));
      r.end();
      if (opts && opts.continueWith) r.finalizeContinuation(opts.continueWith, '重复的解释文字');
      else if (r.pendingContinuation) r.finalizeOriginal();
      return out.join('');
    };

    validate(run(['plain answer only.']), 'plain');
    validate(run(['before <｜DSML｜tool_calls><｜DSML｜invoke name="glob"><｜DSML｜parameter name="pattern">*.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls> after']), 'text+tool+text');
    validate(run(['<｜DSML｜tool_calls><｜DSML｜invoke name="glob"><｜DSML｜parameter name="pattern">*.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>']), 'pure-dsml');
    validate(run(['orphan close </｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls> tail']), 'orphan-tags');
    validate(run(['<invoke name="Write"><parameter name="path">a.md</parameter></invoke>']), 'bare-invoke');
    validate(run(['现在写第 4 篇：'], { continueWith: [{ name: 'Write', input: { path: 'b.md' } }] }), 'autocontinue');
    validate(run(['中断了 <｜DSML｜tool_calls><｜DSML｜invoke name="Write"><｜DSML｜parameter name="path">x']), 'truncated');
    validate(run(['第一段。'], {}), 'halt-fallback');
  }

  // 1k. SPLIT-TAG leakage: a DSML tag with attributes arriving in two chunks
  // must never surface as visible text, no matter where the split falls.
  {
    const full = '好的。<｜DSML｜parameter name="description" string="true">检查 chrome-devtools MCP 配置</｜DSML｜parameter>';
    let leaks = 0, worst = '';
    for (let cut = 1; cut < full.length; cut++) {
      const out = [];
      const r = new SseRepair({}, (s) => out.push(s), { reqId: 'k' + cut });
      r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
      r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(0, cut) } }));
      r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: full.slice(cut) } }));
      r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
      r.push(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      r.end();
      const j = out.join('');
      if (/DSML|parameter name=/.test(j)) { leaks++; if (!worst) worst = `cut=${cut}`; }
    }
    assert(leaks === 0, `split-tag: no leak at any split point (${leaks} leaked, first ${worst})`);
  }

  // 2. streaming: normal text (no DSML) passes through unchanged
  {
    const out = [];
    const r = new SseRepair({}, (s) => out.push(s));
    r.push(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    r.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello world <3 done' } }));
    r.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    r.end();
    const joined = out.join('');
    assert(/Hello world <3 done/.test(joined), 'stream: plain text with "<" preserved');
  }

  // 3. non-stream repair
  {
    const schemas = { get_weather: { properties: { city: { type: 'string' } } } };
    const body = Buffer.from(JSON.stringify({
      type: 'message', role: 'assistant', stop_reason: 'stop',
      content: [{ type: 'text', text: 'Sure.<｜DSML｜function_calls><｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="city">Paris</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>' }],
    }));
    const repaired = repairJsonMessage(body, schemas);
    const j = JSON.parse(repaired.toString());
    assert(j.stop_reason === 'tool_use', 'non-stream: stop_reason rewritten');
    assert(j.content.some(b => b.type === 'tool_use' && b.name === 'get_weather' && b.input.city === 'Paris'), 'non-stream: tool_use parsed');
  }

  // 4. type coercion
  {
    const calls = parseDsml('<invoke name="f"><parameter name="n">3</parameter><parameter name="on">true</parameter></invoke>', { f: { properties: { n: { type: 'integer' }, on: { type: 'boolean' } } } });
    assert(calls[0].input.n === 3 && calls[0].input.on === true, 'coercion: integer/boolean');
  }

  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(ok ? 0 : 1);
}

// Probe mode for tuning the halt detector:
//   node proxy.js --probe "text" [--loop] [--tok N]
function probe() {
  const args = process.argv.slice(2);
  const text = args[args.indexOf('--probe') + 1] || '';
  const loop = args.includes('--loop');
  const ti = args.indexOf('--tok');
  const tok = ti >= 0 ? parseInt(args[ti + 1], 10) : 50;
  const v = analyzeHalt(text, { inToolLoop: loop, outputTokens: tok, toolNames: ['Write', 'Bash', 'Read'] });
  console.log(JSON.stringify({ halt: v.halt, signals: v.why, tok, loop, text }));
}

if (process.argv.includes('--selftest')) selftest();
else if (process.argv.includes('--probe')) probe();
else startServer();
