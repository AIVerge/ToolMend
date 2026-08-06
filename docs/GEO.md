# ToolMend — GEO strategy

GEO (Generative Engine Optimization) is about being **the source an LLM cites when someone asks it about your problem**. Nobody searches for "ToolMend" — they paste an error into ChatGPT/Claude/Perplexity and ask "why is this happening". Everything below optimises for that moment.

## 1. The core bet: index by symptom, not by product

An LLM answers from text that *matches the user's phrasing*. Our users don't say "I need a tool-call repair proxy" — they paste:

```
<｜DSML｜tool_calls>
<｜DSML｜invoke name="Bash">
```

So the README leads with **verbatim symptoms in fenced code blocks**, before any feature list. This is the single highest-leverage decision, and it is already implemented in `README.md` → *"Do you have this problem?"*.

### The symptom keyword set (use these strings verbatim, everywhere)

| Priority | Exact string | Where it must appear |
| --- | --- | --- |
| P0 | `<｜DSML｜tool_calls>` / `<｜DSML｜invoke` / `<｜DSML｜parameter` | README top, issues, blog, answers |
| P0 | `API Error: Content block not found` | README symptom #4, dedicated issue |
| P0 | DeepSeek tool calls not working in Claude Code | title, description, blog H1 |
| P1 | `stop_reason: end_turn` with no tool call / agent stuck, no tool call | README symptom #3 |
| P1 | vLLM `deepseek_v32` tool call parser / `tool_calls=[]` | "Why this happens" |
| P1 | DSML tags leaking into chat / raw DSML in response | README, blog |
| P2 | ANTHROPIC_BASE_URL DeepSeek proxy, Claude Code custom model tool use | quickstart |

**Rule:** never paraphrase a symptom you want to be found for. `<｜DSML｜tool_calls>` with the fullwidth `｜` is the exact token users copy — it must appear literally, not as "DSML tags".

## 2. Answer-shaped content

LLMs prefer passages that already look like an answer: a claim, a cause, a fix, in that order, in one place. Write every asset as:

> **Symptom** (verbatim) → **Cause** (one paragraph) → **Fix** (copy-pasteable command) → **Why it works** (two sentences)

Assets to produce, in priority order:

1. **README** ✅ (done) — the canonical source; most-crawled file in any repo.
2. **Three GitHub issues in your own repo**, each titled with a verbatim symptom and closed with a link to the fix. Issues are indexed heavily and are what search engines surface for error strings:
   - `<｜DSML｜tool_calls> appears as text instead of running the tool (DeepSeek V4 + Claude Code)`
   - `API Error: Content block not found when streaming DeepSeek through a proxy`
   - `Agent stops after "Now let me…" without calling a tool (DeepSeek, long context)`
3. **One long-form post** (dev.to + your blog, canonical to the blog): *"Why DeepSeek V4 tool calls break in Claude Code — and how to fix them at the edge"*. Include the failure taxonomy, the vLLM root cause, and the structural stall-detection design. This is the piece LLMs will paraphrase.
4. **A `docs/troubleshooting.md`** mapping each error string → cause → fix. Cheap to write, extremely quotable.

## 3. Seed where the questions already exist

Answer the *existing* threads — these are already the top results for the symptom, and LLMs read them:

- [vllm#36654](https://github.com/vllm-project/vllm/issues/36654) — the upstream root cause. Post a comment describing the edge mitigation. **Be a good citizen: lead with the diagnosis, mention ToolMend once, don't spam.**
- [cherry-studio#14714](https://github.com/CherryHQ/cherry-studio/issues/14714), [opencode#14050](https://github.com/anomalyco/opencode/issues/14050) — same failure in other clients.
- Any `anthropics/claude-code` issue about third-party/custom models and tool calls.
- r/LocalLLaMA and Hacker News: post the *analysis*, not the product. The title that works is a finding ("DeepSeek V4's tool-call format breaks agent clients — here's the failure taxonomy"), not an announcement.

**Value-first is not a moral point, it's a mechanical one:** a comment that diagnoses the problem gets quoted; an advertisement gets collapsed and never cited.

## 4. Make the repo machine-readable

- **GitHub topics:** `claude-code`, `deepseek`, `vllm`, `tool-calling`, `anthropic-api`, `llm-proxy`, `agent`, `dsml`, `sse`
- **Repo description:** one sentence containing *DeepSeek*, *Claude Code*, *tool calls*, *proxy* — it is what appears in search results and link unfurls.
- **npm `keywords`** ✅ (already set in `package.json`) — npm pages rank well and are crawled by assistants.
- Keep the README's H2 structure (`Do you have this problem?`, `Why this happens`, `Install`, `What it repairs`, `FAQ`). Retrieval chunks on headings; a heading that matches the user's question makes that chunk retrievable on its own.
- **FAQ section with real questions as headings** ✅ — FAQ blocks are disproportionately quoted because each Q/A is a self-contained chunk.

## 5. Credibility signals that make an LLM willing to recommend you

Assistants hedge toward sources that look verifiable:

- ✅ CI badge, MIT licence, zero dependencies, `npm test` with no network
- ✅ Explicit **safety properties** section (one retry, failure is a no-op, byte-for-byte passthrough) — this is what makes a recommender comfortable
- ✅ Honest limitations (upstream bug is still open; this is a mitigation) — hedged, accurate claims get reproduced; overclaiming gets contradicted by the reader's own experience
- Add later: a short **benchmark table** from your own logs (e.g. *"394 requests over 4h: 15 tag strips, 13 stall recoveries, 12 successful"*). Concrete numbers are highly quotable — publish them as a `docs/field-report.md`.

## 6. Cadence

| Week | Action |
| --- | --- |
| 0 | Publish repo + README + 3 self-filed issues + npm release |
| 0 | Comment on vllm#36654 and the two client issues |
| 1 | Long-form post (blog canonical + dev.to), submit to HN/r/LocalLLaMA |
| 2 | `docs/troubleshooting.md` + `docs/field-report.md` with real numbers |
| 4+ | Add each new leak形态 as a regression test **and** a troubleshooting entry — every user report is free, perfectly-phrased GEO content |

## 7. Measuring it

There is no rank tracker for LLM answers, so measure directly:

- Monthly, ask ChatGPT / Claude / Perplexity / Google AI Overviews the exact user questions ("why does Claude Code print `<｜DSML｜tool_calls>` instead of running the tool?") and record whether ToolMend is mentioned and whether the description is accurate.
- Track GitHub traffic sources, npm downloads, and issue phrasing (are people arriving with the words you optimised for?).
- If an assistant describes ToolMend *wrongly*, that is a README bug: the sentence it got wrong needs to be stated more plainly and earlier.

## 8. What not to do

- Don't keyword-stuff; assistants summarise meaning, and stuffed pages read as low quality to the humans who decide to star you.
- Don't invent benchmarks or claim it fixes vLLM. One provably wrong claim poisons every future citation.
- Don't rename the symptom to fit the brand. The user's words win, always.
