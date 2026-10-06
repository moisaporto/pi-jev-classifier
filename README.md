# Jev Classifier for Pi

[![pi](https://img.shields.io/badge/agent-pi-blue)](https://github.com/earendil-works/pi)
[![model](https://img.shields.io/badge/model-OpenRouter%20%2F%20typesafe%2Fjev--1.13-black)](https://openrouter.ai/typesafe/jev-1.13)
[![cost](https://img.shields.io/badge/call-%24~0.00002-green)](#performance)

A [pi](https://github.com/earendil-works/pi) extension that uses **TypeSafe's Jev classification model** — routed through **OpenRouter** — to make the agent safer and sharper. Jev does not chat; it answers narrow, typed questions about a JSON state (choice / yes-no / score) with calibrated probabilities. This extension puts that to work in three places:

| # | Feature | Integration point | What Jev decides |
|---|---------|-------------------|------------------|
| 1 | **Pre-tool risk gate** | `tool_call` event | Is this bash/write/edit call *destructive* and *irreversible*? Blocks it before it runs. |
| 2 | **Post-run verification** | `tool_result` event | Did that test/build actually pass? Alerts the model on hard failures. |
| 3 | **Workspace file ranking** | `/jev-trim <task>` command | Which file is the best starting point for a task, and how relevant is the workspace overall? |

A fourth command, `/jev`, provides status, session toggles, and diagnostics.

---

## How it works

```
                    ┌─────────────────────────────────────────────┐
  tool_call ───────▶│  bypass?  ──yes──▶ run (0 ms, no API call)  │
  (bash/write/edit) │     │no                                     │
                    │     ▼                                       │
                    │  cache hit? ──yes──▶ apply cached verdict   │
                    │     │no                                     │
                    │     ▼                                       │
                    │  Jev classify (risk, irreversible)          │──▶ block / allow
                    └─────────────────────────────────────────────┘

  tool_result ─────▶ matches verification regex? ──▶ Jev classify
  (bash)                                              (status, severity) ──▶ append alert or stay silent
```

### Call paths

Classification is attempted in this order:

1. **Registry path** — `ctx.modelRegistry.classify()` with the classifier model from pi's catalog
   (`openrouter/typesafe/jev-1.13` by default). This gets pi's credential resolution, usage, and cost
   accounting for free.
2. **Direct Decisions API fallback** — if the registry cannot serve a classifier (e.g. a pi build
   whose bundled catalog omits OpenRouter classifier models), the extension calls OpenRouter's
   endpoint directly:

   ```http
   POST https://openrouter.ai/api/alpha/decisions
   Authorization: Bearer <credential resolved by pi>
   ```

   with a top-level `{ model, state, questions }` body. Bool questions are sent as `noul` on the
   wire and normalized back to pi's `bool` answers. Credentials come from your existing
   OpenRouter login — no extra setup.

> [!NOTE]
> On pi `1.0.4` the registry path is unavailable (the bundled model catalog drops OpenRouter
> classifier models), so the extension operates through the direct fallback. Both paths use the
> same model and credentials; `/jev` shows which one is active.

### Fail-open semantics

The gate **never blocks work because Jev is unavailable**. On credential errors, HTTP errors,
timeouts, or aborts, the classification is skipped and the tool call proceeds. Jev's verdict only
blocks when it is *confidently* negative: `risk = destructive` **and** irreversibility ≥ threshold.

---

## Installation

### From GitHub (after this repo is pushed)

```bash
pi install git:github.com/YOUR_GITHUB_USERNAME/pi-jev-classifier
```

### From npm (indexed in the pi.dev package gallery)

```bash
pi install npm:pi-jev-classifier
```

### Local checkout (development / no publishing)

```bash
# install from a local path (loads in place, nothing is copied)
pi install /path/to/pi-jev-classifier

# or try it for one invocation without installing
pi -e /path/to/pi-jev-classifier

# or load just the extension file
pi --extension /path/to/pi-jev-classifier/extensions/index.ts
```

No npm dependencies are needed at runtime — pi loads TypeScript directly via `jiti` and supplies
`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` to extensions. `npm install` is only
needed for editor type checking (`typescript` and `@types/node` are dev dependencies).

Only requirement: **OpenRouter credentials** (OAuth login or API key):

```bash
# Option A: log in interactively once (stored in ~/.pi/agent/auth.json)
/login

# Option B: or export an API key in the environment that starts pi
export OPENROUTER_API_KEY="sk-or-..."
```

---

## Usage

Once installed, patterns 1 and 2 are automatic — nothing to invoke:

```text
you:  reset my postgres to a clean state
pi:   runs: sudo rm -rf /var/lib/postgresql/data
      ⚠ JEV gate blocked bash: … (risk=destructive, irreversible 96%)
      "That was blocked as destructive and irreversible…"

you:  run the tests
pi:   runs: npm test
      [JEV verification] `npm test` hard-failed (severity 74%, confidence 87%).
      Treat the output above as the primary failure signal: identify the root cause
      and fix it before continuing with anything else.
```

### Commands

| Command | Description |
|---------|-------------|
| `/jev` | Show status: active call path, auth, gate/verify state, live counters. |
| `/jev gate on\|off` | Enable/disable the pre-tool risk gate **for this session**. |
| `/jev verify on\|off` | Enable/disable post-run verification **for this session**. |
| `/jev models` | List classifier models available in pi's catalog. |
| `/jev-trim <task>` | Rank workspace files for a task in a single Jev call. |
| `/jev help` | Command summary. |

### `/jev-trim` example

```text
/jev-trim fix the flaky websocket reconnect test

⚡ JEV: ranking 40 workspace files for "fix the flaky websocket reconnect test"…
🎯 Primary: src/ws/reconnect.test.ts
📊 Workspace relevance: 80%
👀 Also consider: src/ws/client.ts (22%), src/ws/reconnect.ts (14%)
```

---

## Configuration

All settings are optional environment variables, read when pi starts:

| Variable | Default | Description |
|----------|---------|-------------|
| `JEV_PROVIDER` | `openrouter` | Classifier provider used for registry resolution. |
| `JEV_MODEL` | `typesafe/jev-1.13` | Classifier model id. |
| `JEV_GATE` | `on` | Pre-tool risk gate (`on`/`off`). |
| `JEV_VERIFY` | `on` | Post-run verification (`on`/`off`). |
| `JEV_IRREVERSIBLE_THRESHOLD` | `0.65` | Block when risk=destructive **and** irreversibility ≥ this. |
| `JEV_FAIL_SEVERITY` | `0.6` | Append a verification alert when status=failed **and** severity ≥ this. |
| `JEV_TIMEOUT_MS` | `6000` | Per-classification timeout; on timeout the gate fails open. |
| `JEV_DEBUG` | off | `1`/`true` traces every decision to stderr. |

Toggles changed via `/jev gate` / `/jev verify` apply to the current session only and reset to the
env defaults on `session_start`.

### Model fallback chain

When the configured model is not credential-ready, the extension walks this chain, then falls back
to any available classifier:

```text
$JEV_PROVIDER/$JEV_MODEL
  → openrouter/typesafe/jev-1.13
  → openrouter/~typesafe/jev-latest
  → typesafe/jev-latest
  → vercel-ai-gateway/typesafe-ai/jev
  → cloudflare-workers-ai/typesafe/jev
  → opencode/jev-1.13
  → any available classifier
```

---

## Decision logic

### Risk gate (pattern 1)

Jev answers two questions per gated call (`bash`, `powershell`, `write`, `edit`):

- `risk` — `choice`: `safe` / `elevated` / `destructive`
- `irreversible` — `bool`: probability the operation is hard to undo

**Block rule:** `risk == destructive && irreversible ≥ 0.65`.

The block reason tells the model what happened and how to proceed honestly (explain the risk, ask
the user for `/jev gate off`, or propose a safer alternative). Nothing is silently rewritten.

**Zero-latency bypass** (no API call, evaluated locally before Jev):

- Read-only first tokens: `ls`, `cat`, `grep`, `rg`, `find`, `git status/log/diff/…`, and more
- Routine build/test invocations: `npm test`, `pnpm run build`, `cargo test`, `go vet`, `tsc`,
  `pytest`, `vitest`, `eslint`, …
- Conservative guards keep risky shapes **gated** even under a safe first token:
  - redirects and pipes to writers (`>`, `>>`, `n>`, `tee`), command/process substitution (`$(…)`, `` `…` ``, `<(`)
  - `find -delete/-exec/-ok`
  - state-changing git arguments (`push`, `reset`, `clean`, `checkout`, `-D`, `--force`, …)
  - interpreters used for anything other than version probes (`node -e`, `python script.py`)
- Identical gated calls are served from an in-memory cache (256 entries, reset each session).

### Post-run verification (pattern 2)

Applies to `bash`/`powershell` results whose command matches the verification regex
(`npm/pnpm/yarn/bun test|build`, `vitest`, `jest`, `pytest`, `cargo test|check`, `go test|vet`,
`tsc`, `eslint`, `ruff`, `mvn`, `gradle`, `dotnet`, `make test`). Jev answers:

- `status` — `choice`: `passed` / `transient` / `failed`
- `severity` — `score` on a 5-level rubric (Jev score answers are **level indices**, normalized to
  0–1 by the extension)

**Alert rule:** `status == failed && severity ≥ 0.6` → a `[JEV verification]` text block is appended
to the tool result, so the model treats the output as the primary failure signal and fixes the root
cause before moving on. Classifier failures stay silent.

### `/jev-trim` (pattern 3)

Walks the working directory (≤400 files, depth ≤ 5, skips `.git`/`node_modules`/build dirs), takes
the 40 most recently touched files, and asks Jev in **one** call:

- `topFile` — `choice` over the candidate paths (runner-ups from the answer's probability distribution)
- `relevance` — `score` on a 5-level rubric, reported as a percentage

---

## Observability

```bash
# trace every decision in any pi mode
JEV_DEBUG=1 pi

# example output
[jev] session start (gate=on, verify=on)
[jev] gate bypass (read-only): git status && git diff
[jev] classify ok via direct Decisions API (typesafe/jev-1.13) (551 tokens)
[jev] gate BLOCKED bash: sudo rm -rf /var/lib/postgresql/data (risk=destructive, irreversible 96%)
[jev] verify ALERT: cd /app && npm test → status=failed, severity 74%
```

`/jev` shows the same information interactively, plus counters:

```text
Model: openrouter/typesafe/jev-1.13 — direct Decisions API (registry catalog has no OpenRouter classifiers)
openrouter auth: configured (stored)
Gate: on (irreversible ≥ 65%)
Verify: on (severity ≥ 60%)
Calls: 3 classified, 1 blocked, 1 alerts, 0 errors
```

---

## Troubleshooting

<details>
<summary><code>/jev</code> says the model is unresolved, or gate always allows</summary>

- Run `/jev` and check the auth line. If `missing`, log in with `/login` (choose OpenRouter) or set
  `OPENROUTER_API_KEY` in the shell that starts pi.
- Run `pi auth check --provider openrouter` — it should print `ready`.
- Set `JEV_DEBUG=1` and look for `[jev] model resolution failed: …`.
</details>

<details>
<summary>Model line shows <em>"direct Decisions API"</em> instead of the registry</summary>

Your pi build's catalog omits OpenRouter classifier models (observed on pi `1.0.4`). This is fine —
the direct fallback uses the same model and your stored credentials; only pi's built-in token/cost
accounting is skipped. A future pi release should restore the registry path automatically.
</details>

<details>
<summary>Gate blocks something I want to run</summary>

```text
/jev gate off     # rest of this session, then re-run the command
```

Re-enable with `/jev gate on`. For a permanent change, set `JEV_GATE=off` in the environment —
but consider `JEV_IRREVERSIBLE_THRESHOLD=0.9` first; it keeps a high-confidence safety net.
</details>

<details>
<summary>Verification alerts are too noisy / too quiet</summary>

Tune `JEV_FAIL_SEVERITY` (default `0.6`): lower it to alert on more failures, raise it to alert only
on hard blockers. `/jev verify off` disables the pattern for the session.
</details>

---

## Performance

Measured on the live OpenRouter endpoint (typesafe/jev-1.13):

| Metric | Value |
|--------|-------|
| Classification call | one round trip, ~550 tokens, ≈ $0.00002 (measured live) |
| Read-only bypass | 0 ms, 0 tokens |
| Cached verdict | 0 ms, 0 tokens |
| Cost per agent turn | ≈ $0.00002 × (1 gated call + optional verification) |

Jev answers all questions for a call in a single round trip, and the gate asks only two.