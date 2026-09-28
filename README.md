# dsh-memvault

<p align="center">
  <strong>Push MemVault's core memory into the DeepSeek Harness system prompt — and let every finished turn flow back.</strong><br>
  Host-only bundle · zero runtime dependencies · no build step · no second server
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-4a6cf7">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-30a46c">
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-f76b15">
  <img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-zero-888">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.13-339933">
  <img alt="stars" src="https://img.shields.io/github/stars/zhang66633/dsh-memvault?style=flat&color=e3b341">
</p>

---

**dsh-memvault** is the missing half of a memory system that already exists. **MemVault** (a local long-term-memory service: a SQLite store, a FastAPI/CLI pipeline and a stdio MCP server) stores facts, embeds them and retrieves them — but it is a **stdio MCP server**, and MCP is a *pull* protocol: the server can only be *called*, it has no channel to put anything into the model's context. So "memory is already loaded" can never be achieved from the MCP side. It has to be done by the client, which is this plugin.

The plugin does two things, in both directions:

| Half | What it does | Mechanism |
|---|---|---|
| **Inject** (read) | Core memory blocks enter the system prompt, visible on **every** step without the model calling a tool | `ctx.systemPrompt.context()` — a dynamic runtime-context contribution (the same channel as `skill-catalog`) |
| **Extract** (write) | Every *N*th finished turn, the turn's transcript is handed to MemVault's extraction/embedding pipeline | `ctx.on('session/event')` → `turn/end` → `python -m memvault.cli add --stdin` |

## ✨ Features

| | |
|---|---|
| 🧠 **Injection without tool calls** | Core blocks land in a dynamic runtime context, so they are re-evaluated on every `assemble()` and the model simply *has* them |
| 🗄️ **Direct read-only SQLite** | Node's built-in `node:sqlite` opens `memvault.db` read-only — no HTTP hop, no subprocess, no third-party dependency, no server that must be up |
| 💾 **TTL-cached rendering** | The system prompt *is* the KV-cache prefix; re-reading and re-rendering every step is wasted work and any byte change invalidates reuse — so the render is cached (`refreshMs`, default 30 s) |
| 🧩 **Turn-boundary slicing** | The write half slices the turn from its own bounded event log by `turn/end` boundaries: idempotent, restart-proof, no watermark arithmetic to go stale |
| ⏱️ **Cost-aware extraction** | `everyNTurns` throttles the Python process, `minTranscriptChars` skips trivia, `endReasons` decides which turn endings count, `timeoutMs` kills a stuck child |
| 🎭 **Role filtering** | Assistant prose and tool traffic are excluded by default — shipping them stored the model's own words as "facts about the user" |
| 🪶 **Zero runtime dependencies** | Plain ESM over the harness plugin protocol: `node:sqlite`, `node:child_process`, `node:fs`. Nothing to install, nothing to build |
| 🖥️ **Host-only bundle** | No `dsh.client` half, therefore no browser bundle, no `pnpm run build`, no HMR receiver: it works on every DSH surface, including a headless one |
| 🛟 **Fail-soft by design** | An unreadable store serves the last good text and warns once; a broken extraction never fails a turn and never poisons the next one |
| 🔍 **Observable from outside** | Watermarks and the last five extraction diagnostics are written atomically to one JSON file, so "hook never fired" is distinguishable from "turn too short" from "ran and found nothing" |

## 🧭 Compatibility

| Question | Answer |
|---|---|
| **DSH Desktop** | ✅ Verified live on the reserved `desktop` profile: the bundle (`dsh.bundle.patch`) loads, the plugin row is `active`, and the injected blocks appear in the runtime-context snapshot. |
| **Do I need a client half?** | No. This is a host-only bundle: `package.json` declares no `dsh.client`, so there is no browser bundle to build and nothing to keep in sync with the Web shell. |
| **DSH Web / headless / SDK profiles** | ✅ The same bundle works wherever the host runs, because the injected contribution is host-side. `systemPrompt.context()` is the only service it injects. |
| **A visible panel?** | ❌ Nothing in the GUI. There is no settings page and no conversation-ring panel — the only visible traces are the `memvault:core` entry in the execution trajectory's *injected context* list, the plugin row on the Plugins page, and the state JSON. A client half is on the [roadmap](#-roadmap). |
| **Windows / macOS / Linux** | ✅ Windows works out of the box with the author's layout; on other platforms point `MEMVAULT_DIR` / `MEMVAULT_PYTHON` at the checkout (a POSIX venv uses `.venv/bin/python`), or set the three paths in `cordis.patch.yml`. |
| **Node** | `>= 22.13` (flag-free `node:sqlite`). DSH ships its own Node, so this is only a statement about the plugin's API floor. |
| **Other harnesses (Claude Code, Codex, …)** | ❌ Not this plugin. It is written against the cordis/DSH surface (`ctx.systemPrompt.context`, `session/event`). Those harnesses reach the same store through MemVault's own MCP tools, CLI, or API. |

## 🚀 Quick start

**Prerequisite:** a working MemVault checkout — its virtualenv and its `memvault.db` (the store is shared with the MemVault service and MCP clients; this plugin only ever `SELECT`s from it).

Self-owned install (what this repo does on the author's machine):

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-memvault": "link:D:/_Projects/skill_mcp/dsh-memvault" },
  "dsh": { "profile": { "bundles": ["…", "dsh-memvault", "…"] } }
}
```

```powershell
# make the module resolvable from the profile
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-memvault" `
  -Target "D:\_Projects\skill_mcp\dsh-memvault"
```

**Restart DSH after adding a bundle** — an already-loaded patch file hot-reloads, a newly added bundle does not.

> ⚠️ Two known traps. `dsh plugin add` rewrites the profile's `package.json`, and the `dsh.profile.bundles` array can silently lose *other* plugins' entries — always re-read the whole list afterwards. And pnpm can replace the `link:` junction; recreate it if the bundle suddenly stops loading.

Installing from npm or a git spec is the same operation through `dsh plugin` or the Web sidebar's **Plugins** page (see `@deepseek-ai/dsh-plugin-manager`).

## ⚙️ Configuration

Everything is a code default; a `config` block in `cordis.patch.yml` overrides it.

### Read half

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` injects the empty string forever |
| `dbPath` | `$MEMVAULT_DB_PATH` else `D:/Claude_code/memory/data/memvault.db` | Path to `memvault.db` |
| `scopes` | `[{user,lenovo},{agent,claude-code-memory}]` | Blocks are keyed by `(scope_type, scope_id)`; **both halves must be given explicitly** — a foreign process has no "current scope" |
| `labels` | `[]` | Only these labels; empty means every block in the scopes |
| `maxChars` | `4000` | Budget for the **whole rendered string**, header included |
| `refreshMs` | `30000` | TTL for the cached render |
| `order` | `210` | Position among runtime-context contributions (e.g. relative to `skill-catalog`) |
| `name` | `memvault:core` | The name shown in the trajectory's injected-context list |

### Write half (`config.extract`)

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin read-only |
| `everyNTurns` | `3` | Extract once per N **finished** turns; `1` = every turn |
| `endReasons` | `['completed','max-tokens']` | Which `turn/end` reasons count. `aborted` / `error` / `interrupted` / `blocked` are skipped — but `max-tokens` is not, because a truncated turn still holds the user's message |
| `includeAssistant` / `includeTools` | `false` / `false` | The extractor does not separate roles; the assistant's own prose became stored "facts", so it is off by default |
| `maxInputChars` | `6000` | Transcript budget; newest lines win, oldest are dropped |
| `minTranscriptChars` | `40` | Below this a turn is not worth a process plus an LLM call — it is skipped, and the watermark still advances |
| `timeoutMs` | `120000` | Timeout kills the child and records one warning |
| `pythonPath` | `$MEMVAULT_PYTHON` else `<MEMVAULT_DIR>/.venv/{Scripts/python.exe,bin/python}` | Interpreter that can `import memvault` |
| `projectDir` | `$MEMVAULT_DIR` else `D:/Claude_code/memory` | Working directory of the child |
| `user` / `agent` / `run` | `lenovo` / `claude-code-memory` / unset | The three axes are orthogonal; any combination is allowed |
| `env` | `{PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8'}` | Child environment. Removing these reintroduces the cp936/emoji bug below |
| `statePath` | `~/.dsh/storages/dsh-memvault-state.json` | Watermarks + the last five diagnostics; atomic write |

## 🏗️ How it works

```mermaid
flowchart LR
  subgraph HOST["DSH host process"]
    LOOP["Agent loop"]
    ASM["systemPrompt.assemble()"]
    CTX["ctx.systemPrompt.context('memvault:core')"]
    HOOK["ctx.on('session/event')"]
    BUFF["bounded event log<br/>400/session · 32 sessions"]
  end

  DB[("memvault.db<br/>blocks · memories")]
  PY["python -m memvault.cli add --stdin"]
  STATE["dsh-memvault-state.json"]

  DB -->|"read-only SELECT ~1 ms"| CTX
  CTX -->|"dynamic runtime context, TTL 30 s"| ASM
  ASM --> LOOP

  LOOP --> HOOK
  HOOK --> BUFF
  BUFF -->|"turn/end boundary slice"| PY
  PY -->|"extract · embed · upsert"| DB
  HOOK --> STATE
```

Read path, per step:

1. `assemble()` asks every dynamic context for its text.
2. `memvault:core` returns the cached render unless the TTL expired; on expiry it opens the store read-only and re-renders.
3. Blocks are rendered as `- [scope_type/scope_id/label] value`, headed by one attribution line, bounded by `maxChars`.
4. An empty render returns `''`, the assembler drops the empty contribution, and nothing appears in the trajectory — that is the intended behaviour for an empty store, not a fault.

Write path, per finished turn:

1. Every appended session event is buffered per session (bounded on both axes).
2. On `turn/end` with an accepted reason, the turn counter advances.
3. Every `everyNTurns`-th turn is sliced **by turn boundary** from that buffer, rendered to a user-only transcript (oldest lines dropped first), and, if long enough, queued.
4. Extractions are serialized: one child at a time, and a failure in one turn cannot poison the next.
5. MemVault does the rest — LLM extraction, ADD/UPDATE/DELETE decisions, embeddings, relations — so written rows are actually *retrievable*.

## 🧪 Verification

No DSH needed:

```bash
npm test              # all three suites
npm run smoke:package # package/bundle contract: manifest, patch row, exports, peers
npm run smoke         # reader + formatter + budget contract, against the real db (read-only)
npm run smoke:extract # transcript, boundary slicing, event buffer, watermarks, and a REAL end-to-end write into a throwaway db
```

The end-to-end step forces the offline embedder and rule extractor in a temporary database: it never touches the real store and never calls the configured gateway.

**Live check.** After a restart, the trajectory's *injected context* list gains a `memvault:core` entry whose content is your actual blocks, and the Plugins page shows the bundle's row (`memvault-core-context`) as active. `~/.dsh/storages/dsh-memvault-state.json` reports the write half's outcome: `skipped: transcript below minTranscriptChars`, `ok added=N`, or `failed: …`.

## 🧠 Design decisions

**Why a direct SQLite read rather than HTTP or the CLI.** `GET /api/v1/blocks` needs the FastAPI server alive on 8780 — if it is down, the prompt silently loses memory. Spawning the CLI costs ~200–300 ms per refresh. `node:sqlite` costs ~1 ms and depends on nothing running. The store is shared with the MemVault service, but this only `SELECT`s, and a `timeout: 2000` busy timeout keeps a concurrent writer from surfacing `SQLITE_BUSY` to the prompt assembler. `node:sqlite` is still *experimental* in Node 24 — a documented risk, and the reason the write half deliberately does not depend on it.

**Why the render is cached.** The system prompt is the KV-cache prefix. Re-reading and re-rendering on every step is wasted work, and any byte change invalidates cache reuse from that point on. Core blocks are edited by a human on the scale of hours; a 30 s TTL is both cheap and cache-friendly.

**Why the write half is a CLI call rather than a direct insert.** Writing rows straight into SQLite would skip extraction and embedding — the rows would exist and be unretrievable. `--stdin` rather than argv because a turn transcript blows past the command-line length limit. The cost is one Python process per extracted turn, which is exactly what `everyNTurns` and `minTranscriptChars` exist to control.

**Why only core blocks are injected, and not per-turn semantic recall.** Recall results change every turn; putting them in the system-prompt prefix would invalidate the cache on every step. That content belongs in a user message with its provenance, not in the prompt prefix.

**Why `turn/end` reasons are configurable.** The agent loop emits `completed`, `max-tokens`, `blocked`, `aborted`, `error`, plus `interrupted` from the repair path. Accepting only `completed` silently drops turns that ended on `max-tokens` — which still contain real user content.

## ⚠️ Known limits

- **No extraction window.** Extraction is synchronous and ships a single turn. Batching several turns and running asynchronously would be cheaper and give a better signal-to-noise ratio; today `includeAssistant: false` is the mitigation.
- **Source changes need a real host restart.** Editing the plugin's own `lib/*.js` (or its config) is only picked up by a genuine process restart — "refresh the UI" is not enough, and the symptom is simply *no change*.
- **`node:sqlite` is experimental** in the Node versions DSH currently ships.
- **Machine-specific defaults.** `scopes` defaults to the author's `(user, lenovo)` / `(agent, claude-code-memory)` pairs, and the shipped patch points at the author's checkout. Both are meant to be edited.

## 🗺️ Roadmap

- **A client half** — a panel tab that shows the blocks currently injected and the last extraction outcomes, i.e. the observability that today lives in a JSON file.
- **Async, windowed extraction** — accumulate N turns or idle out, then extract in the background.
- **A config schema** so the Plugins page can edit the knobs instead of a hand-written patch.

## 📄 License

[MIT](./LICENSE) © 2026 zhang66633

Development notes, every dead end and every measured pitfall live in [docs/DEVLOG.md](docs/DEVLOG.md).
