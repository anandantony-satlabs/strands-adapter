# pi-strands-adapter

pi extension that registers one tool, `strands_decide`, running the **Jev (System One)
decision-model paradigm** over the **strands-decider** structured API
(`POST {baseURL}/v1/systemone`) — the successor to `pi-jev-adapter`.

The strands service is a purpose-built decision model, not a chat LLM. You POST one
`state` plus a map of typed questions and it returns one calibrated,
probability-distributed answer per question with a confidence score. It owns model
selection, decoding and normalisation server-side, so there is **no** reasoning_effort
vocabulary, **no** max_tokens juggling, **no** parse-retry tier, and **no** config-file
model registry — the adapter is just a thin translation layer.

> Serving reference: [`strands-labs/strands-decider`](https://github.com/strands-labs/strands-decider).
> We don't ship a default service — the built-in default is the neutral `http://127.0.0.1:8008`, so you bring your own `strands-decider serve` deployment (see [Security](#security)).

## Which model decides

The server decides. The default request omits `model`, so the server's
`strands-decider-latest` alias applies; the response reports the real checkpoint
(e.g. `strands-decider-2B-hobson-v19`). Override with `STRANDS_MODEL` (or the config file)
if you run a second server under a different alias.

Question types (tool → wire):

| Tool | Wire | You give | You get back |
|---|---|---|---|
| `choice` | `choice` | options (`criteria` object option→description, or array) | picked option + distribution + confidence |
| `score` | `score` | ordered levels (`criteria` array low→high, 2–10) | fractional score + per-level probabilities + confidence |
| `boolean` | `noul` | a statement | P(true) — with two outcomes the probability *is* the uncertainty, so no confidence |

## Usage

Ask the agent to make atomic judgements; it batches them into `strands_decide` calls.

```
Classify these support tickets: department + urgency + frustration.
```

**One state, many questions is the cheap path.** The state is encoded once and its KV
cache is broadcast across the question batch, so the marginal cost of an extra question
is much lower than a fresh call (measured against `strands-decider-2B-hobson-v19`: ~20ms
marginal per extra question vs ~45ms for a standalone call; latency grows roughly linear
with question count, e.g. 12 questions ≈ 250ms). Still cheaper than fanning out N separate
calls. Put every judgement you need in a
single `state` call:

```
^strands_decide(state={commit: "...", diff: "..."},
           questions={
             dept:      {type: "choice",   instructions: "Which team owns this?", criteria: {eng: "...", ops: "...", docs: "..."}},
             urgency:   {type: "score",    instructions: "How urgent to merge?", criteria: ["can wait","merge soon","hotfix now"]},
             needs_human:{type: "boolean", instructions: "A human should review this before merge."},
           })
```

**Multiple independent states** (commits, tickets, diffs you can't collapse into one
state) go in `states=[{id, state}, ...]`; the adapter issues one `/v1/systemone` call per
state, answered keyed by state id. These run **sequentially by default** because the
upstream server does not verify concurrent requests (there is a documented race in the
torch engine) — raise `STRANDS_MAX_CONCURRENCY` only if you have confirmed your deployment
tolerates parallelism.

Route on confidence: `≥0.85 → act`, `0.5–0.85 → draft + human confirm`, `<0.5 → escalate`.
Tune thresholds to the risk of the action. (These are the repo's stated calibration bands:
on short classification tasks, ~0.9-confidence answers are right ~95% of the time.)

## Endpoint resolution

1. `STRANDS_BASE_URL` / `STRANDS_API_KEY` / `STRANDS_MODEL` / `STRANDS_TIMEOUT_MS` /
   `STRANDS_MAX_CONCURRENCY` env vars (optional)
2. the first existing of `strands-adapter.config.json` (next to `index.ts`) or
   `~/.pi/agent/strands-adapter.json` (a personal override that survives upstream updates;
   also pointed at by `STRANDS_CONFIG`)
3. built-in default `http://127.0.0.1:8008` (bring your own service)

Per field: call opts → env → config file → built-in default. No model registry, no
secrets in this repo — at most a hostname, and `apiKey` is env/call-only (never read from
a config file, so it can't be committed).

## Inspecting / verifying

```
^/strands-config           # resolved baseURL/model/timeout/concurrency + live /health probe
/strands-config check     # the same, plus one live decision at the server's model
```

## Notes on the API (from the strands-decider repo)

- The server binds its own host and has **no authentication**; use it as a private/local
  deployment, and it is not verified under concurrent requests.
- A `choice` needs 2–255 options; a `score` needs 2–10 levels; a `noul` may take an
  optional `criteria` whose keys must be a subset of `{"true","false"}`.
- `state` may be a string, object, or array; an option description may be structured data.
- Each question is evaluated independently (no question sees another's text), which keeps
  answers decomposable.

## Security notes

- The resolved `apiKey` (if any) is sent as a Bearer header to whatever `baseURL`
  resolves to. `apiKey` comes from `STRANDS_API_KEY` (or call opts) only — never from a
  config file — and `strands-adapter.config.json` is gitignored. Only point
  `STRANDS_BASE_URL` (or a config file) at endpoints you trust.
- Probabilities are **self-reported estimates / calibrated model outputs**, not proof.
  Every result carries the caveat; keep a human in the loop for high-risk actions.
- The extension performs network calls to the configured decision endpoint only. No
  `eval`, no child processes, no files written.

## Credits

Inspired by `dsh-jev-adapter` (MIT, BetterZflyee) and `pi-jev-adapter`.
Decision model and server: [strands-labs/strands-decider](https://github.com/strands-labs/strands-decider).
