/**
 * dsh-memvault — MemVault ⇄ DeepSeek Harness bridge.
 *
 * Three halves:
 *
 * 1. **Inject** (read): core memory blocks go into the system prompt as a dynamic
 *    runtime context contribution, so every step sees them without the model
 *    having to call a tool. MCP cannot do this — it is a pull protocol and the
 *    server has no channel into the context.
 *
 * 2. **Extract** (write): finished turns accumulate into a window which is handed
 *    to MemVault as one conversation, which runs its own extraction/embedding
 *    pipeline. This is the half dsh-memory used to own; without it the store only
 *    grows when the model happens to call `memory_add`.
 *
 * 3. **Panel** (browser): the injected blocks, the extraction outcomes, and
 *    editing the blocks, served by exact host routes.
 *
 * Configuration is described once in `config.js`; `schema.js` turns that same
 * description into the Config schema DSH validates and the Plugins page renders.
 */
import { formatCoreBlocks, readCoreBlocks } from './blocks.js'
import {
  createEventBuffer,
  loadState,
  renderTranscript,
  runExtraction,
  saveWatermarks,
  turnSpanByBoundary,
} from './extract.js'
import { BLOCKS_PATH, FLUSH_PATH, MEMORIES_PATH, REFRESH_PATH, STATUS_PATH, buildStatus, createPanelApi } from './panel.js'
import { runBlockAction } from './blocks-write.js'
import { readMemories } from './memories.js'
import { createTurnWindow } from './window.js'
import { MEMVAULT_DIR, MEMVAULT_PYTHON, configDefaults, resolveConfig } from './config.js'

/** Plugin row id (must match the name in cordis.patch.yml). */
export const name = 'dsh-memvault'

/** The prompt registry is the only service this needs. */
export const inject = ['systemPrompt']

/**
 * The Config schema, when a Schemastery implementation is reachable (in DSH it
 * always is). `undefined` means "no schema declared": the entry still loads, it
 * just gets no config validation and no generated settings page.
 */
export { Config, schemaAvailable } from './schema.js'

/** MemVault checkout the write half drives, and its interpreter (see `config.js`). */
export { MEMVAULT_DIR, MEMVAULT_PYTHON }

/**
 * Extraction defaults, derived from the config spec — one description of every
 * knob, so the code defaults, the schema defaults and the README cannot drift.
 */
export const DEFAULT_EXTRACT = configDefaults().extract

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

  // Everything below reads the resolved config: defaults come from the spec,
  // values written differently (a numeric string) are coerced, and anything
  // unrecognised or wrong is reported once instead of silently ignored.
  const resolved = resolveConfig(config)
  const settings = resolved.config
  if (resolved.unknown.length > 0) {
    warnOnce('config-unknown', `ignoring unknown config key(s): ${resolved.unknown.join(', ')}`)
  }
  if (resolved.problems.length > 0) {
    warnOnce('config-problems', `config: ${resolved.problems.join('; ')}`)
  }
  if (!settings.extract.enabled && config?.extract?.enabled === undefined) {
    // Not a problem, but a surprising default to inherit silently.
    ctx.logger?.info?.('dsh-memvault: extraction is disabled, running read-only')
  }

  // ── half 1: core blocks → system prompt ────────────────────────────────────
  const enabled = settings.enabled !== false
  const dbPath = settings.dbPath
  const scopes = settings.scopes
  const labels = settings.labels
  const maxChars = settings.maxChars
  const order = settings.order
  const contextName = settings.name
  const refreshMs = settings.refreshMs

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
  const extract = settings.extract
  // Loaded even when extraction is off: the panel reports the history, and
  // "extraction is off" is exactly the state a reader needs to be able to see.
  const state = loadState(extract.statePath)
  const watermarks = state.watermarks
  // Last few extraction attempts, written into the state file so the outcome is
  // observable from outside the host process (see saveWatermarks).
  const diagnostics = state.diagnostics
  // Not-yet-extracted windows, keyed by session; written back on every change so
  // a restart between turns loses nothing.
  let pending = state.pending ?? {}
  // Our own log of what the harness actually hands us: `session.events` is not an
  // array on this object (see createEventBuffer), so the turn slice comes from here.
  const eventLog = createEventBuffer()
  let queue = Promise.resolve()

  // ── half 3: the panel's data API (optional surface) ────────────────────────
  // `panel.writes: false` makes the panel read-only: the write route then answers
  // 403 instead of running MemVault's CLI.
  const panelWrites = settings.panel?.writes !== false
  // Bound the persisted windows: the panel and the recovery path are the only
  // readers, and an unbounded map in one small file is a slow leak.
  const MAX_PENDING_SESSIONS = 4
  const MAX_RECOVERED_WINDOWS = 5

  /**
   * Reads the extraction window, which is created further down and only when
   * extraction is enabled — the panel registers earlier on purpose, because it
   * must keep working (read-only) with extraction switched off.
   */
  let pendingWindows = () => []

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
      configIssues: { unknown: resolved.unknown, problems: resolved.problems },
      extract: {
        ...extract,
        sessions: watermarks.size,
        diagnostics: diagnostics.slice(-5).reverse(),
        pendingWindows: pendingWindows(),
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
      // Extraction disabled ⇒ no window exists, so there is nothing to flush and
      // the route says so instead of pretending it queued something.
      flush: extract.enabled ? () => ({ flushed: turnWindow.flushAll() }) : null,
      // The browse view reads the same store the prompt reads, read-only.
      readMemories: (query) => readMemories({ dbPath, query }),
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
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: FLUSH_PATH,
      handler: api.flush,
    }), 'dsh-memvault: panel flush route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: MEMORIES_PATH,
      handler: api.memories,
    }), 'dsh-memvault: panel memories route')
  })

  if (!extract.enabled) return

  /**
   * Serialize extractions: one MemVault process at a time, and a failure in one
   * window must not poison the next.
   */
  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => {
      warnOnce('extract-crash', `extraction failed: ${error?.message ?? error}`, error)
    })
  }

  /** Render a window of turns into one bounded, user-only transcript. */
  function renderWindow(turns) {
    const events = turns.flatMap((turn) => turn.events ?? [])
    return renderTranscript(events, extract.maxInputChars, {
      includeAssistant: extract.includeAssistant === true,
      includeTools: extract.includeTools === true,
    })
  }

  /**
   * Persist what is still waiting.
   *
   * The window makes the "in flight" period much longer than it used to be (an
   * idle timer, up to `windowTurns` turns), so anything not written down is what a
   * restart between turns would silently lose. Only the rendered text is kept —
   * bounded by `maxInputChars` — and only for the newest few sessions.
   */
  function persistPending() {
    const windows = turnWindow.pendingWindows()
    const next = {}
    for (const entry of windows.slice(0, MAX_PENDING_SESSIONS)) {
      const turns = turnWindow.turns(entry.sessionId)
      const text = renderWindow(turns)
      if (text === '') continue
      next[entry.sessionId] = {
        at: entry.at,
        turns: turns.length,
        seq: turns.at(-1)?.seq ?? null,
        chars: text.length,
        text,
      }
    }
    pending = next
    saveWatermarks(watermarks, extract.statePath, diagnostics, pending)
  }

  /** Drop a session's persisted window (after it was extracted, or skipped). */
  function clearPending(sessionId) {
    if (pending[sessionId] === undefined) return
    delete pending[sessionId]
    saveWatermarks(watermarks, extract.statePath, diagnostics, pending)
  }

  /**
   * The one place that talks to MemVault for extraction — a window, or a window
   * recovered from the state file after a restart.
   */
  async function extractTranscript(sessionId, { text, turns, seq, recovered = false }) {
    if (seq !== null && seq !== undefined) watermarks.set(sessionId, seq)

    if (text.replace(/\s/g, '').length < extract.minTranscriptChars) {
      // Too little to be worth a Python process plus an LLM call. The watermark
      // still advances so the same turns are never re-mined.
      diagnostics.push({
        at: new Date().toISOString(),
        seq,
        turns,
        transcriptChars: text.length,
        outcome: 'skipped: transcript below minTranscriptChars',
      })
      if (diagnostics.length > 5) diagnostics.shift()
      clearPending(sessionId)
      return
    }

    const result = await runExtraction({
      config: extract,
      messages: [{ role: 'user', content: text }],
    })
    diagnostics.push({
      at: new Date().toISOString(),
      seq,
      turns,
      transcriptChars: text.length,
      outcome: result.ok ? `ok added=${result.added ?? 0}` : `failed: ${result.error}`,
      ...(recovered ? { recovered: true } : {}),
    })
    if (diagnostics.length > 5) diagnostics.shift()
    clearPending(sessionId)

    if (result.ok) {
      ctx.logger?.info?.(
        `dsh-memvault: extracted ${result.added ?? 0} memory item(s) from ${turns} turn(s)${recovered ? ' (recovered window)' : ''}`,
      )
    } else {
      warnOnce('extract-fail', `extraction failed: ${result.error}`, null)
    }
  }

  /** Hand one session's window to MemVault. */
  async function extractWindow(sessionId, turns) {
    await extractTranscript(sessionId, {
      text: renderWindow(turns),
      turns: turns.length,
      seq: turns.at(-1)?.seq ?? null,
    })
  }

  const turnWindow = createTurnWindow({
    everyNTurns: extract.everyNTurns,
    windowTurns: extract.windowTurns,
    idleMs: extract.idleMs,
    flush: (sessionId, turns) => enqueue(() => extractWindow(sessionId, turns)),
  })
  // Timers belong to the plugin: disposing it must not leave one behind.
  ctx.effect(() => () => turnWindow.dispose(), 'dsh-memvault: extraction window')
  // From here the panel can show what is waiting in the window.
  pendingWindows = () => turnWindow.pendingWindows()

  /**
   * Restart recovery: windows that were waiting when the process stopped are
   * extracted on mount rather than forgotten. Newest first, because those are the
   * ones a user is most likely to still care about; anything beyond the cap is
   * reported as skipped instead of disappearing quietly.
   */
  const recovered = Object.entries(pending)
    .sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
  for (const [sessionId, entry] of recovered.slice(0, MAX_RECOVERED_WINDOWS)) {
    enqueue(() => extractTranscript(sessionId, {
      text: String(entry?.text ?? ''),
      turns: Number(entry?.turns ?? 0),
      seq: entry?.seq ?? null,
      recovered: true,
    }))
  }
  if (recovered.length > MAX_RECOVERED_WINDOWS) {
    const dropped = recovered.length - MAX_RECOVERED_WINDOWS
    diagnostics.push({
      at: new Date().toISOString(),
      seq: null,
      turns: 0,
      transcriptChars: 0,
      outcome: `skipped: ${dropped} recovered window(s) beyond the first ${MAX_RECOVERED_WINDOWS}`,
    })
    if (diagnostics.length > 5) diagnostics.shift()
    saveWatermarks(watermarks, extract.statePath, diagnostics, pending)
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
    // Slice by turn boundary over OUR buffered events — `session.events` is not an
    // array here, which is what made every earlier strategy yield an empty window.
    const span = turnSpanByBoundary(eventLog.get(sessionId), event)
    if (span.length === 0) return
    turnWindow.push(sessionId, {
      events: span,
      seq: event.seq,
      at: new Date().toISOString(),
      reason: event.data?.reason?.kind ?? null,
    })
    persistPending()
  })
}
