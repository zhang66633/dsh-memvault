/**
 * dsh-memvault — MemVault ⇄ DeepSeek Harness bridge.
 *
 * Two halves:
 *
 * 1. **Inject** (read): core memory blocks go into the system prompt as a dynamic
 *    runtime context contribution, so every step sees them without the model
 *    having to call a tool. MCP cannot do this — it is a pull protocol and the
 *    server has no channel into the context.
 *
 * 2. **Extract** (write): on every Nth completed turn the turn's transcript is
 *    handed to MemVault, which runs its own extraction/embedding pipeline. This is
 *    the half dsh-memory used to own; without it the store only grows when the
 *    model happens to call `memory_add`.
 */
import { DEFAULT_DB_PATH, DEFAULT_SCOPES, formatCoreBlocks, readCoreBlocks } from './blocks.js'
import {
  DEFAULT_STATE_PATH,
  createEventBuffer,
  loadState,
  renderTranscript,
  runExtraction,
  saveWatermarks,
  turnSpanByBoundary,
} from './extract.js'
import { BLOCKS_PATH, REFRESH_PATH, STATUS_PATH, buildStatus, createPanelApi } from './panel.js'
import { runBlockAction } from './blocks-write.js'

/** Plugin row id (must match the name in cordis.patch.yml). */
export const name = 'dsh-memvault'

/** The prompt registry is the only service this needs. */
export const inject = ['systemPrompt']

/**
 * MemVault checkout the write half drives, and its interpreter.
 *
 * Paths are the only thing in this plugin that is not portable, so both are
 * read from the environment before falling back to the author's layout:
 * `MEMVAULT_DIR` (default `D:/Claude_code/memory`) and `MEMVAULT_PYTHON`
 * (default `<dir>/.venv/Scripts/python.exe` on Windows, `<dir>/.venv/bin/python`
 * everywhere else — the two venv layouts). Both defaults are also what a
 * `link:`-installed bundle needs, so nothing here is a hidden requirement:
 * `config.extract.pythonPath` / `projectDir` in `cordis.patch.yml` override them.
 */
export const MEMVAULT_DIR = process.env.MEMVAULT_DIR ?? 'D:/Claude_code/memory'

/** Interpreter that can `import memvault` — the venv, not the system python. */
export const MEMVAULT_PYTHON = process.env.MEMVAULT_PYTHON
  ?? (process.platform === 'win32'
    ? `${MEMVAULT_DIR}/.venv/Scripts/python.exe`
    : `${MEMVAULT_DIR}/.venv/bin/python`)

/** Extraction defaults; see README. */
export const DEFAULT_EXTRACT = {
  enabled: true,
  everyNTurns: 3,
  // Turn-end reasons come from the agent loop's own taxonomy — verified in
  // `@deepseek-ai/dsh-agent-loop`, which emits completed / max-tokens / blocked /
  // aborted / error, plus `interrupted` from the session repair path. Filtering on
  // `completed` alone (what dsh-memory did) is too narrow: a turn that ends on
  // max-tokens is still a real turn with real user content, and skipping it would
  // silently lose memories.
  endReasons: ['completed', 'max-tokens'],
  // Role filtering: the extractor does not separate roles, so the assistant's own
  // prose was stored as facts ("智能体运行在 DSH 上"). Off by default.
  includeAssistant: false,
  includeTools: false,
  maxInputChars: 6000,
  minTranscriptChars: 40,
  timeoutMs: 120_000,
  pythonPath: MEMVAULT_PYTHON,
  projectDir: MEMVAULT_DIR,
  user: 'lenovo',
  agent: 'claude-code-memory',
  run: null,
  // Force UTF-8 for the child. Without this the CLI decodes stdin with the host's
  // locale codec (cp936 here); a transcript containing any character GBK cannot
  // represent (an emoji, say) becomes lone surrogates, and httpx then dies
  // encoding them for the gateway: "surrogates not allowed". Same class of bug as
  // the MCP stdio fix in the MemVault repo's Sprint 13, on the CLI side.
  env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  statePath: DEFAULT_STATE_PATH,
}

/**
 * Mount the plugin.
 * @param ctx - cordis context.
 * @param config - plugin config; see README for the fields.
 */
export function apply(ctx, config = {}) {
  const warnOnce = (() => {
    const warned = new Set()
    return (key, message, error) => {
      if (warned.has(key)) return
      warned.add(key)
      ctx.logger?.warn?.(`dsh-memvault: ${message}`, error ?? '')
    }
  })()

  // ── half 1: core blocks → system prompt ────────────────────────────────────
  const enabled = config.enabled !== false
  const dbPath = config.dbPath ?? DEFAULT_DB_PATH
  const scopes = config.scopes ?? DEFAULT_SCOPES
  const labels = config.labels ?? []
  const maxChars = config.maxChars ?? 4000
  const order = config.order ?? 210
  const contextName = config.name ?? 'memvault:core'
  const refreshMs = config.refreshMs ?? 30_000

  /**
   * Cached render + the exact blocks it was built from.
   *
   * Keeping `blocks` beside `text` costs nothing (the read produced them anyway)
   * and is what the panel renders: the browser cannot read the store itself.
   */
  let cache = { text: '', at: 0, blocks: [], error: null }

  /** One read: blocks, then the rendered prompt text. Throws if the store is unreadable. */
  function readNow() {
    const blocks = readCoreBlocks({ dbPath, scopes, labels })
    return { blocks, text: formatCoreBlocks(blocks, { maxChars }) }
  }

  /**
   * Current injection text, refreshed only when older than the TTL.
   *
   * `assemble()` runs every step and the system prompt is the KV-cache prefix, so
   * re-reading and re-rendering per step would be wasted work and any byte change
   * would invalidate cache reuse. Core blocks change on human timescales.
   *
   * Fail-soft: if the store is unreadable we keep serving the last good text and
   * warn once — a memory bridge must never be why a turn fails.
   */
  function current() {
    if (!enabled) return ''
    const now = Date.now()
    // A cached *empty* result counts too: an empty store must not be re-read on
    // every step either.
    if (cache.at !== 0 && now - cache.at < refreshMs) return cache.text
    try {
      cache = { ...readNow(), at: now, error: null }
    } catch (error) {
      cache = { ...cache, at: now, error: String(error.code ?? error.message) }
      warnOnce('read', `cannot read ${dbPath} (${error.code ?? error.message}); serving the last known blocks, if any.`, error)
    }
    return cache.text
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: contextName,
    order,
    text: () => current(),
  }), 'dsh-memvault: core memory context')

  // ── half 2: turn/end → MemVault write pipeline ─────────────────────────────
  const extract = { ...DEFAULT_EXTRACT, ...(config.extract ?? {}) }
  // Loaded even when extraction is off: the panel reports the history, and
  // "extraction is off" is exactly the state a reader needs to be able to see.
  const state = loadState(extract.statePath)
  const watermarks = state.watermarks
  // Last few extraction attempts, written into the state file so the outcome is
  // observable from outside the host process (see saveWatermarks).
  const diagnostics = state.diagnostics
  const turns = new Map()
  // Our own log of what the harness actually hands us: `session.events` is not an
  // array on this object (see createEventBuffer), so the turn slice comes from here.
  const eventLog = createEventBuffer()
  let queue = Promise.resolve()

  // ── half 3: the panel's data API (optional surface) ────────────────────────
  // `panel.writes: false` makes the panel read-only: the write route then answers
  // 403 instead of running MemVault's CLI.
  const panelWrites = config.panel?.writes !== false

  /**
   * The payload the browser half renders.
   *
   * Read fresh only when the TTL says so — the panel polls, and polling must not
   * turn into a per-second SQLite read. With the read half disabled the store is
   * still read *for the panel* (an explicit user action) but never cached into
   * the prompt path, so "what would be injected" stays answerable.
   */
  function snapshot() {
    if (enabled) current()
    else {
      try {
        cache = { ...cache, ...readNow() }
      } catch (error) {
        cache = { ...cache, error: String(error.code ?? error.message) }
      }
    }
    return buildStatus({
      read: {
        enabled,
        name: contextName,
        order,
        dbPath,
        scopes,
        labels,
        maxChars,
        refreshMs,
        cacheAgeMs: cache.at === 0 ? null : Date.now() - cache.at,
        renderedChars: cache.text.length,
        error: cache.error,
      },
      blocks: cache.blocks,
      writable: panelWrites,
      extract: {
        ...extract,
        sessions: watermarks.size,
        diagnostics: diagnostics.slice(-5).reverse(),
      },
    })
  }

  // `webServer` is optional on purpose: a headless composition has no browser,
  // and an unavailable service must never keep the memory bridge from injecting.
  // `ctx.inject` starts a child fiber that waits for the service instead.
  const writeConfig = {
    pythonPath: extract.pythonPath,
    projectDir: extract.projectDir,
    env: extract.env,
    // A block write is one small upsert — it must not inherit the 120 s budget
    // extraction needs for an LLM call.
    timeoutMs: 30_000,
  }
  ctx.inject(['webServer'], (panelCtx) => {
    const api = createPanelApi({
      status: () => snapshot(),
      refresh: () => {
        // Force the next `current()` past the TTL: the point of the button is
        // "I just edited a core block, show me the new text now".
        cache = { ...cache, at: 0 }
        return snapshot()
      },
      writeBlock: panelWrites
        ? async (input) => {
          const out = await runBlockAction({ config: writeConfig, input })
          // A write changes the store, so the next assemble must not serve a
          // render that predates it.
          if (out.ok) cache = { ...cache, at: 0 }
          return out
        }
        : null,
    })
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: api.status,
    }), 'dsh-memvault: panel status route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: REFRESH_PATH,
      handler: api.refresh,
    }), 'dsh-memvault: panel refresh route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: BLOCKS_PATH,
      handler: api.blocks,
    }), 'dsh-memvault: panel blocks route')
  })

  if (!extract.enabled) return

  /**
   * Serialize extractions: one MemVault process at a time, and a failure in one
   * turn must not poison the next.
   */
  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => {
      warnOnce('extract-crash', `extraction failed: ${error?.message ?? error}`, error)
    })
  }

  async function extractTurn(session, event) {
    const sessionId = String(session.id)
    // Slice by turn boundary over OUR buffered events — `session.events` is not an
    // array here, which is what made every earlier strategy yield an empty window.
    const span = turnSpanByBoundary(eventLog.get(sessionId), event)
    const transcript = renderTranscript(span, extract.maxInputChars, {
      includeAssistant: extract.includeAssistant === true,
      includeTools: extract.includeTools === true,
    })
    // Kept only as an observability breadcrumb now — nothing depends on it.
    watermarks.set(sessionId, event.seq)

    if (transcript.replace(/\s/g, '').length < extract.minTranscriptChars) {
      // A trivial turn (a one-word reply and back) is not worth a Python process
      // plus an LLM call; the watermark still advances so it is never re-mined.
      diagnostics.push({
        at: new Date().toISOString(),
        seq: event.seq,
        events: span.length,
        buffered: eventLog.get(sessionId).length,
        sessionKeys: Object.keys(session ?? {}).slice(0, 12),
        transcriptChars: transcript.length,
        outcome: 'skipped: transcript below minTranscriptChars',
      })
      if (diagnostics.length > 5) diagnostics.shift()
      saveWatermarks(watermarks, extract.statePath, diagnostics)
      return
    }

    const result = await runExtraction({
      config: extract,
      messages: [{ role: 'user', content: transcript }],
    })
    diagnostics.push({
      at: new Date().toISOString(),
      seq: event.seq,
      events: span.length,
      transcriptChars: transcript.length,
      outcome: result.ok ? `ok added=${result.added ?? 0}` : `failed: ${result.error}`,
    })
    if (diagnostics.length > 5) diagnostics.shift()
    saveWatermarks(watermarks, extract.statePath, diagnostics)

    if (result.ok) {
      ctx.logger?.info?.(`dsh-memvault: extracted ${result.added ?? 0} memory item(s) from turn @${event.seq}`)
    } else {
      warnOnce('extract-fail', `extraction failed: ${result.error}`, null)
    }
  }

  const endReasons = new Set(extract.endReasons ?? DEFAULT_EXTRACT.endReasons)

  ctx.on('session/event', (session, event) => {
    // Buffer EVERY event: this observer is called for each appended event, and it
    // is the only event source we can rely on.
    eventLog.push(String(session?.id), event)
    if (event?.type !== 'turn/end') return
    // Only turns that finished on purpose. `aborted` / `error` / `interrupted` /
    // `blocked` are skipped by default; `max-tokens` is NOT, because a truncated
    // turn still contains the user's message.
    if (!endReasons.has(event.data?.reason?.kind)) return
    const sessionId = String(session.id)
    const count = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, count)
    if (count < extract.everyNTurns) return
    turns.set(sessionId, 0)
    enqueue(() => extractTurn(session, event))
  })
}
