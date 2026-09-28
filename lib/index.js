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
  loadWatermarks,
  renderTranscript,
  runExtraction,
  saveWatermarks,
  turnSpanByBoundary,
} from './extract.js'

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

  /** Cached render + when it was produced. */
  let cache = { text: '', at: 0 }

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
      const text = formatCoreBlocks(readCoreBlocks({ dbPath, scopes, labels }), { maxChars })
      cache = { text, at: now }
    } catch (error) {
      cache = { text: cache.text, at: now }
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
  if (!extract.enabled) return

  const watermarks = loadWatermarks(extract.statePath)
  const turns = new Map()
  // Our own log of what the harness actually hands us: `session.events` is not an
  // array on this object (see createEventBuffer), so the turn slice comes from here.
  const eventLog = createEventBuffer()
  // Last few extraction attempts, written into the state file so the outcome is
  // observable from outside the host process (see saveWatermarks).
  const diagnostics = []
  let queue = Promise.resolve()

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
