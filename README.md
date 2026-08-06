# ToolMend

**Make DeepSeek V4 / vLLM work reliably with Claude Code — no more leaked `<｜DSML｜tool_calls>` markup or turns that stop without calling a tool.**

[![test](https://github.com/AIVerge/ToolMend/actions/workflows/test.yml/badge.svg)](https://github.com/AIVerge/ToolMend/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/toolmend)](https://www.npmjs.com/package/toolmend)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

ToolMend is a tiny, zero-dependency reverse proxy that sits between your agent client and your LLM gateway. It repairs tool calls that the backend failed to parse, and restarts turns where the model announced an action but never performed it.

```
Claude Code  ──►  ToolMend :29090  ──►  your gateway / vLLM  ──►  DeepSeek V4
```

One line to adopt, one line to roll back:

```bash
npx toolmend --upstream http://127.0.0.1:8080 --port 29090
# then point the client at it:
export ANTHROPIC_BASE_URL=http://127.0.0.1:29090
```

---

## Do you have this problem?

If any of these look familiar, ToolMend is built for exactly this:

**1. Raw DSML markup printed instead of running the tool**

```
<｜DSML｜tool_calls>
<｜DSML｜invoke name="Bash">
<｜DSML｜parameter name="command">ls -la</｜DSML｜parameter>
```

The agent prints protocol tags as chat text and stops. Nothing executes.

**2. Stray closing tags after a tool already ran**

```
</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

**3. The model "thinks", promises to act, then stops**

```
Now let me write the spec file:
        ← turn ends here, no tool call, agent waits forever
```

**4. `API Error: Content block not found`**

Malformed streaming events (index gaps) crash the client mid-turn.

**5. Tool calls truncated halfway**

```
<invoke name="Write"><parameter name="content">The first half of the fi
```

### Why this happens

DeepSeek V4 / V3.2 emit tool calls in their own **DSML** (DeepSeek Markup Language) format. When the serving stack's tool-call parser doesn't understand it, the markup is passed through as ordinary assistant text instead of becoming a structured tool call — so the agent never executes anything. It gets worse with long context and multi-turn tool loops, where the model's "thinking" and "acting" phases come apart.

Upstream references: [vllm-project/vllm#36654](https://github.com/vllm-project/vllm/issues/36654) · [CherryHQ/cherry-studio#14714](https://github.com/CherryHQ/cherry-studio/issues/14714) · [opencode#14050](https://github.com/anomalyco/opencode/issues/14050)

ToolMend fixes this **at the edge**, without patching vLLM, your gateway, or the client.

---

## Deploy

### Step 0 — find your upstream

ToolMend needs to know **where it should forward to**: the endpoint your client talks to today. Look at your current `ANTHROPIC_BASE_URL`:

```bash
echo "$ANTHROPIC_BASE_URL"
# or
grep ANTHROPIC_BASE_URL ~/.claude/settings.json
```

That value is your `--upstream`. ToolMend takes its place; the old value moves behind it.

```
before:  Claude Code ─────────────────────────────► http://gateway:8080
after:   Claude Code ──► ToolMend :29090 ─────────► http://gateway:8080
                              ▲                            ▲
                        new ANTHROPIC_BASE_URL         --upstream
```

### Option A — one-click install (recommended)

Installs the service, starts it, verifies health, and offers to repoint Claude Code for you:

```bash
curl -fsSL https://raw.githubusercontent.com/AIVerge/ToolMend/main/install.sh \
  | bash -s -- --upstream http://127.0.0.1:8080
```

<details>
<summary>What the installer does</summary>

1. Checks Node ≥ 18 and that your port is free
2. Installs to `/opt/toolmend` (root) or `~/.local/share/toolmend` (user)
3. **Runs the self-test and aborts if it fails**
4. Registers a service — systemd on Linux, launchd on macOS — with graceful shutdown
5. Polls `/healthz` until ToolMend is actually serving
6. Optionally rewrites `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, **after backing it up**

It is idempotent: re-run it to upgrade. Flags: `--port`, `--host`, `--wire-claude`, `--no-wire-claude`, `--uninstall`.
</details>

```bash
# upgrade  — same command again
# remove   — bash install.sh --uninstall
```

### Option B — npm

```bash
npm install -g toolmend
toolmend --upstream http://127.0.0.1:8080 --port 29090
```

Or without installing anything:

```bash
npx toolmend --upstream http://127.0.0.1:8080
```

### Option C — plain Node, no install at all

`src/toolmend.js` is a **single file with zero dependencies**. Copy it anywhere and run it with Node:

```bash
# 1. grab the one file
curl -fsSL https://raw.githubusercontent.com/AIVerge/ToolMend/main/src/toolmend.js -o toolmend.js

# 2. check it works (offline, no network needed)
node toolmend.js --selftest

# 3. run it
UPSTREAM=http://127.0.0.1:8080 LISTEN_PORT=29090 node toolmend.js
```

Keep it running after you close the terminal:

```bash
UPSTREAM=http://127.0.0.1:8080 nohup node toolmend.js > toolmend.out 2>&1 &
```

To stop it:

```bash
pkill -f toolmend.js          # SIGTERM — drains in-flight streams first
```

All configuration is environment variables, so nothing else is needed:

```bash
LISTEN_HOST=127.0.0.1 \
LISTEN_PORT=29090 \
UPSTREAM=http://127.0.0.1:8080 \
TOOLMEND_LOG=./toolmend.log \
node toolmend.js
```

<details>
<summary>systemd unit, if you prefer to write it yourself</summary>

```ini
# /etc/systemd/system/toolmend.service
[Unit]
Description=ToolMend
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/toolmend/src/toolmend.js
Environment=LISTEN_PORT=29090
Environment=UPSTREAM=http://127.0.0.1:8080
Environment=TOOLMEND_LOG=/var/log/toolmend.log
KillSignal=SIGTERM
TimeoutStopSec=310
Restart=always

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` matters: ToolMend drains in-flight streams on `SIGTERM`, so restarts never cut off a live request.
</details>

---

## Use it

### 1. Point your client at ToolMend

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:29090"
  }
}
```

or per-shell:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:29090
```

**Restart Claude Code** — it reads this at startup.

### 2. Confirm it is in the path

```bash
curl -s http://127.0.0.1:29090/healthz
```

```json
{
  "ok": true, "service": "toolmend", "version": "0.1.0",
  "upstream": "http://127.0.0.1:8080", "inFlight": 0, "uptimeSec": 42,
  "autocontinue": true,
  "repairs": { "requests": 128, "dsmlRepaired": 0, "tagsStripped": 15,
               "truncated": 1, "continuations": 13, "recovered": 12 }
}
```

`repairs` is a live tally — if those numbers climb while you work, ToolMend is catching real failures.

Send a real request through it:

```bash
curl -N http://127.0.0.1:29090/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"YOUR_MODEL","max_tokens":100,"stream":true,
       "tools":[{"name":"get_weather","input_schema":{"type":"object",
         "properties":{"city":{"type":"string"}}}}],
       "messages":[{"role":"user","content":"Weather in Paris? Call get_weather."}]}'
```

A healthy result contains `"type":"tool_use"` and ends with `"stop_reason":"tool_use"` — **not** raw `<｜DSML｜…>` text.

### 3. Watch it work

```bash
tail -f /var/log/toolmend.log            # installed as a service
journalctl -u toolmend -f                # systemd journal
tail -f ./toolmend.log                   # plain node run
```

### 4. Roll back

Nothing to undo but one variable — put your original URL back in `ANTHROPIC_BASE_URL` and restart the client. Then optionally:

```bash
bash install.sh --uninstall
```

---

## What it repairs

| Failure | What ToolMend does |
| --- | --- |
| DSML tool call leaked as text | Parses it into a proper `tool_use` block and rewrites `stop_reason` to `tool_use` |
| Stray/orphan DSML tags | Strips them from the visible text, keeping the prose intact |
| Bare `<invoke name="…">` with no wrapper | Parsed as a real tool call (never silently dropped) |
| Tool call cut off mid-stream | Refuses to emit a half-parsed call; requests it again instead |
| Model announced work but never acted | Fires **one** follow-up request and splices the recovered tool call into the same turn |
| Broken block indices | Renumbers all content blocks contiguously so clients never see `Content block not found` |

Everything else is forwarded **byte for byte**. If nothing is broken, ToolMend is a pass-through.

### Stall detection is structural, not a keyword list

Detecting "the model announced work but didn't act" uses **wording-independent signals**, so it generalises across phrasings and languages instead of chasing a vocabulary list:

- **Dangling utterance** — ends on a colon/comma/open bracket/unclosed code fence, or has no terminal punctuation at all
- **Mid tool-loop position** — the request's last message is a `tool_result`, i.e. the model was called specifically to react to a tool
- **Output size** — a couple of tokens of narration where an action was due
- **Forward intent** — closed-set function words (`我将`, `接下来`, `let me`, `I'll`, `continuing`…), never action verbs

With two hard vetoes so normal conversation is never touched:

- **Soliciting the user** (`?`, `告诉我`, `would you like`, `shall I`) → a legitimate hand-off, left alone
- **Completion report** (`已完成`, `I've updated`, `tests pass`, `done`) → a legitimate ending, left alone

Ask the detector directly:

```bash
$ toolmend --probe "Now let me write the spec file:" --loop --tok 40
{"halt":true,"signals":"dangling+toolloop+short+tiny+forward","tok":40,"loop":true,...}

$ toolmend --probe "Fixed the bug in parser.js." --loop --tok 40
{"halt":false,"signals":"toolloop+short+tiny+completed",...}
```

### When ToolMend acts, you can see it

A recovered turn carries a visible marker, so an unusual-looking answer is never a mystery:

```
⟦proxy⟧ detected a completed thought with no tool call; re-issued it.
```

Disable with `--no-marker`. Disable the whole recovery path with `--no-autocontinue`.

---

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Bind address |
| `LISTEN_PORT` | `29090` | Bind port |
| `UPSTREAM` | `http://127.0.0.1:8080` | Your gateway / inference server |
| `TOOLMEND_LOG` | `./toolmend.log` | Request + repair log |
| `DSML_AUTOCONTINUE` | `1` | `0` disables stall recovery |
| `DSML_AUTOCONTINUE_MARK` | `1` | `0` hides the `⟦proxy⟧` marker |
| `DSML_AUTOCONTINUE_MAX_OUT_TOKENS` | `15000` | Skip recovery above this output size |
| `DSML_AUTOCONTINUE_NUDGE` | *(built-in)* | Prompt used to re-request the tool call |
| `DSML_AUTOCONTINUE_MARK_TEXT` | *(built-in)* | Text of the visible `⟦proxy⟧` marker |

CLI flags map onto these: `--port`, `--host`, `--upstream`, `--log`, `--no-autocontinue`, `--no-marker`.

### Endpoints

| Path | Purpose |
| --- | --- |
| `/healthz` | Liveness + upstream + live repair counters (never forwarded upstream) |
| everything else | Proxied to `UPSTREAM`, repaired only when broken |

## Observability

Every request is logged, and every repair is explicit:

```
REQ reqId=ab12cd34 POST /v1/messages model=… stream=true tools=26 bytes=134545
AUTOCONTINUE reqId=ab12cd34 thinking->acting break (out_tok=16 signals=empty-text loop=true); firing 1 continuation
AUTOCONTINUE reqId=ab12cd34 recovered 1 tool call(s): Read
RES reqId=ab12cd34 sse status=200 stop=end_turn out_tok=16 tool=no ms=7018 cont=recovered:1
```

Two extra files help you tune it:

- `toolmend.anomaly.log` — raw dumps of every leaked/broken tool call
- `toolmend.autocontinue.log` — **every** stalled-looking turn, whether or not it was acted on, with the signals that fired. `"triggered": false` entries are your false-negative dataset.

```bash
grep '"triggered":false' toolmend.autocontinue.log | tail -20
```

## Troubleshooting

**Nothing changed after installing.**
The client reads `ANTHROPIC_BASE_URL` at startup — restart it. Verify the value actually took effect, then confirm traffic arrives: `curl -s localhost:29090/healthz` and watch `repairs.requests` climb as you use the agent.

**`ECONNREFUSED` / 502 from ToolMend.**
`--upstream` is wrong or the gateway is down. `/healthz` echoes the upstream ToolMend is using; test that URL directly with `curl`.

**504 after exactly 60 seconds.**
Not ToolMend — that is a proxy in front of your backend (nginx defaults to `proxy_read_timeout 60s`). Either raise it, or point `--upstream` past that proxy at the backend directly. Large prompts can exceed 60s in prefill alone.

**The agent still stops without calling a tool.**
Check whether ToolMend saw it: every stalled-looking turn is recorded in `toolmend.autocontinue.log`, including ones it deliberately left alone.

```bash
grep '"triggered":false' toolmend.autocontinue.log | tail -5
```

Then ask the detector about that exact text:

```bash
toolmend --probe "<the model's last words>" --loop --tok 40
```

If it says `halt:false` and you disagree, that entry is a perfect bug report — [open an issue](https://github.com/AIVerge/ToolMend/issues) with it.

**`API Error: Content block not found`.**
This is a malformed event stream. ToolMend renumbers content blocks specifically to prevent it; if you still see it, please file an issue with the `reqId` from the log.

**ToolMend recovered a tool call, but it did the wrong thing.**
First confirm it was ToolMend: a turn it acted on contains `⟦proxy⟧ detected a completed thought…`. Stall recovery is the only heuristic here — it re-asks the model, so what comes back is not guaranteed to be what the model originally intended. You can switch off just that part and keep every deterministic repair:

```bash
toolmend --upstream ... --no-autocontinue      # or DSML_AUTOCONTINUE=0 in your unit file
```

| | default | `--no-autocontinue` |
| --- | --- | --- |
| DSML tag stripping | ✅ | ✅ kept |
| DSML → `tool_use` reconstruction | ✅ | ✅ kept |
| Block renumbering (`Content block not found`) | ✅ | ✅ kept |
| Truncated tool-call protection | ✅ | ✅ kept |
| **Re-issuing a tool call after a stall** | ✅ | ❌ off |

With it off, stalls simply stall again — but nothing is ever inferred on your behalf. Please send the matching `toolmend.autocontinue.log` entry to [an issue](https://github.com/AIVerge/ToolMend/issues); it carries the `signals` and the model's own words, which is exactly what a fix and a regression test need.

**Port already in use.**
`--port 29091`, or find the squatter: `ss -ltnp | grep 29090`.

**Restarting drops my request.**
It shouldn't — ToolMend drains in-flight streams on `SIGTERM`. Make sure your systemd unit has a generous `TimeoutStopSec` (the installer sets 310s). If you run it by hand, stop it with `pkill -f toolmend.js` (SIGTERM), not `kill -9`.

## Safety properties

- **One retry, ever.** A turn is never continued more than once.
- **Failure is a no-op.** If recovery finds no tool call, the original response is passed through unchanged.
- **Never invents work.** Recovery only runs when the model itself announced an action.
- **No content rewriting.** Untouched responses are forwarded byte-for-byte.
- **Graceful shutdown.** In-flight streams drain on `SIGTERM`.

## Tests

```bash
npm test     # 110+ assertions, no network required
```

The suite covers each repair path plus a stream well-formedness validator that asserts block indices start at 0, stay contiguous, and every block is opened before use and closed exactly once — the invariant whose violation produces `Content block not found`. Split-tag tests replay every possible chunk boundary of a DSML tag.

## FAQ

**Does this only work with DeepSeek?**
That is what it is tuned for, but nothing is DeepSeek-specific in the transport: it speaks the Anthropic Messages API and forwards anything it doesn't need to repair. Any backend that leaks tool-call markup as text can benefit.

**Does it work with non-streaming requests?**
Yes, both SSE and JSON responses are repaired.

**Will it slow things down?**
Untouched requests add sub-millisecond overhead. Stall recovery costs one extra upstream call (typically a few seconds) — only on turns that would otherwise have hung indefinitely.

**Isn't the real fix in vLLM?**
Yes. [vllm#36654](https://github.com/vllm-project/vllm/issues/36654) is the upstream bug and it is still open. ToolMend is the edge mitigation you can deploy today, and it costs one environment variable to remove once upstream lands a fix.

**Does it see my API key?**
Headers are forwarded untouched and never logged. ToolMend stores no credentials.

## Contributing

Hit a leak ToolMend didn't catch? Open an issue with the `toolmend.autocontinue.log` entry (or the raw text) — that entry is usually enough to add a regression test and a fix. Please don't paste API keys.

## License

MIT
