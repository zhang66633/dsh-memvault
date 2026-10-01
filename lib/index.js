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
import { readFileSync, statSync } from 'node:fs'
import { formatCoreBlocks, readCoreBlocks } from './blocks.js'
import {
  createEventBuffer,
  loadState,
  renderTranscript,
  runExtraction,
  saveState,
  saveWatermarks,
  turnSpanByBoundary,
} from './extract.js'
import {
  BLOCKS_PATH,
  FLAG_PATH,
  FLUSH_PATH,
  MEMORIES_PATH,
  MEMORY_PATH,
  REFRESH_PATH,
  REPLAY_PATH,
  REVIEW_PATH,
  STATUS_PATH,
  STRUCTURE_PATH,
  buildStatus,
  createPanelApi,
} from './panel.js'
import { runBlockAction } from './blocks-write.js'
import { countRetyped, readMemories, readMemoryProvenance } from './memories.js'
import { buildStructure } from './structure.js'
import { flaggedIds, normalizeFlags, setFlag } from './flags.js'
import {
  MAX_REVIEW_ITEMS,
  buildReviewRequest,
  pruneInputs,
  pruneProduced,
  recordProduced,
  shapeReviewItem,
  storeInput,
  validateReplay,
} from './review.js'
import { createTurnWindow } from './window.js'
import { MEMVAULT_DIR, MEMVAULT_PYTHON, configDefaults, discoverySnapshot, resolveConfig } from './config.js'

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

/**
 * Is the store file there, and how big?
 *
 * Setup-time information: "the path is wrong" and "the path is right but nothing
 * has been written yet" both show zero memories, and only the file itself tells
 * them apart. Never throws — a stat failure is reported as `exists: false`.
 */
export function dbFileInfo(dbPath) {
  try {
    const stats = statSync(dbPath)
    return { exists: true, bytes: stats.size, modifiedAt: stats.mtime.toISOString() }
  } catch {
    return { exists: false, bytes: 0, modifiedAt: null }
  }
}

/**
 * Do the configured paths actually resolve?
 *
 * Setup-time validation. Without it a wrong `pythonPath` or `projectDir` shows up
 * only as "extraction quietly stopped", and a wrong `dbPath` as "my memories are
 * gone" — both much later, and both easy to misread as a bug in the memory itself.
 * Each entry is `{ key, label, target, ok, detail }`; nothing here throws.
 */
export function checkPaths({ pythonPath, projectDir, dbPath, statePath } = {}) {
  const isDir = (path) => {
    try { return statSync(path).isDirectory() } catch { return false }
  }
  const isFile = (path) => {
    try { return statSync(path).isFile() } catch { return false }
  }
  const parentOf = (path) => {
    if (typeof path !== 'string' || path === '') return ''
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return cut > 0 ? path.slice(0, cut) : path
  }
  const checks = []

  checks.push(pythonPath
    ? {
      key: 'python',
      label: 'Python',
      target: pythonPath,
      ok: isFile(pythonPath),
      detail: isFile(pythonPath) ? '可执行文件存在' : '找不到这个 python（抽取与写块都会失败）',
    }
    : { key: 'python', label: 'Python', target: '', ok: false, detail: '未配置 pythonPath' })

  checks.push(projectDir    ? {
      key: 'projectDir',
      label: 'MemVault 项目目录',
      target: projectDir,
      ok: isDir(projectDir) && isDir(`${projectDir.replace(/[\\/]+$/, '')}/memvault`),
      detail: !isDir(projectDir)
        ? '目录不存在'
        : (isDir(`${projectDir.replace(/[\\/]+$/, '')}/memvault`) ? '目录里能找到 memvault 包' : '目录存在，但找不到 memvault/ 包（可能指错了地方）'),
    }
    : { key: 'projectDir', label: 'MemVault 项目目录', target: '', ok: false, detail: '未配置 projectDir' })

  checks.push({
    key: 'db',
    label: '库文件',
    target: dbPath ?? '',
    // Missing file is fine as long as its folder exists: MemVault creates the file
    // on the first write. A missing *folder* is the case that silently fails.
    ok: isFile(dbPath) || isDir(parentOf(dbPath)),
    detail: isFile(dbPath)
      ? '文件存在'
      : (isDir(parentOf(dbPath)) ? '文件还不存在，父目录可写就会在首次写入时创建' : `父目录不存在：${parentOf(dbPath)}`),
  })

  checks.push({
    key: 'state',
    label: '插件状态文件',
    target: statePath ?? '',
    ok: statePath === undefined || statePath === '' || isFile(statePath) || isDir(parentOf(statePath)),
    detail: statePath ? (isFile(statePath) ? '文件存在' : `尚未创建（父目录${isDir(parentOf(statePath)) ? '存在' : '不存在'}）`) : '未配置 statePath（会用默认位置）',
  })

  // The service's own answer to "which store". This plugin states its path to the
  // children it spawns, but MemVault also reads its project `.env`, and anything that
  // talks to the store without going through the plugin — an MCP server, a plain CLI
  // call — uses that one. Two answers to the same question is the confusion 0.9.6
  // spent a release removing, so it is checked here rather than left invisible.
  const envFile = `${parentOf(dbPath ?? '')}/.env`
  const envText = (() => {
    for (const candidate of [envFile, `${projectDir ?? ''}/.env`]) {
      if (candidate === '' || !isFile(candidate)) continue
      try { return { path: candidate, text: readFileSync(candidate, 'utf8') } } catch { /* unreadable: try the next */ }
    }
    return null
  })()
  const declared = (() => {
    if (envText === null) return null
    for (const line of envText.text.split('\n')) {
      const match = /^\s*MEMVAULT_DB_PATH\s*=\s*(.*)$/.exec(line.trim())
      if (match) return match[1].trim().replace(/^["']|["']$/g, '')
    }
    return null
  })()
  // Windows treats D:\x\y.db and d:/x/y.db as one file, and a false "mismatch" would
  // be its own small lie.
  const normalize = (value) => String(value ?? '').split('\\').join('/').toLowerCase()
  if (declared === null) {
    checks.push({
      key: 'serviceStore',
      label: '服务端库文件（.env）',
      target: envText?.path ?? envFile,
      ok: true,
      detail: envText === null
        ? '没有 .env，服务端会用相对默认 data/memvault.db（与插件的 dbPath 同目录时才一致）'
        : '.env 里没有 MEMVAULT_DB_PATH',
    })
  } else {
    const same = normalize(declared) === normalize(dbPath)
    checks.push({
      key: 'serviceStore',
      label: '服务端库文件（.env）',
      target: envText.path,
      ok: same,
      detail: same
        ? `${declared} · 与插件的库文件一致`
        : `${declared} · 与插件的库文件不一致——不经插件的调用（MCP 工具等）读的是它，不是面板显示的这份`,
    })
  }

  return checks
}

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
   * One source for the store path, shared by this plugin's reads and by every
   * child process it spawns.
   *
   * Before this, the children found the store only through their cwd plus
   * MemVault's relative default (`data/memvault.db`), which merely happened to
   * point at the same file as `read.dbPath`. Changing either side silently split
   * the memory in two — the symptom being "I know I saved that". An explicit
   * `MEMVAULT_DB_PATH` in `extract.env` still wins: that is the deliberate
   * override, not an accident.
   */
  const childEnv = {
    ...(settings.extract?.env ?? {}),
    MEMVAULT_DB_PATH: settings.extract?.env?.MEMVAULT_DB_PATH ?? dbPath,
  }

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
  // The panel's review marks on stored memories. Plugin state, never store state.
  let flags = normalizeFlags(state.flags)
  // The review loop's own state: what each window sent, and which memory each
  // window produced (see review.js).
  let inputs = pruneInputs(state.inputs)
  let producedIndex = pruneProduced(state.produced)
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
      // Whether the configured store file is actually there, and how big. The panel
      // shows this at setup time: "the path exists but nothing is in it" and "the
      // path is wrong" look identical in a row count alone.
      dbFile: dbFileInfo(dbPath),
      // Does the configuration actually resolve? Reported at setup time, because a
      // wrong path otherwise surfaces much later as "extraction stopped" or "my
      // memories are gone" — and both read as a bug in the memory, not the wiring.
      paths: checkPaths({
        pythonPath: extract.pythonPath,
        projectDir: extract.projectDir,
        dbPath,
        statePath: extract.statePath,
      }),
      // How those paths were decided — and, when nothing was found, what was looked
      // at. Without this the plugin can be talking to another vault with no sign of
      // it anywhere in the UI.
      discovery: discoverySnapshot(),
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
    // Same store the panel reads (see `childEnv`): the path is stated, not inferred
    // from a cwd plus a default that merely coincided.
    env: childEnv,
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
      // The structure view: which scope dimensions hold what, which blocks are
      // actually injected, and the relation graph as it stands. `scopes` comes from
      // this plugin's own config, which is the only place that knows what is
      // injected — the store cannot tell you that.
      readStructure: () => buildStructure({
        dbPath,
        injectedScopes: (scopes ?? []).map((scope) => `${scope.type}/${scope.id}`),
        flags: normalizeFlags(flags),
        retypedCount: countRetyped({ dbPath }),
      }),
      // The browse view reads the same store the prompt reads, read-only, and
      // carries the review flags — which live here, not in MemVault.
      readMemories: (query) => {
        const flagsNow = normalizeFlags(flags)
        const extra = {
          flags: flagsNow,
          flaggedCount: Object.keys(flagsNow).length,
          produced: producedIndex,
          // How many rows the store's type refinement moved out of `user`. The
          // panel shows the number and can filter by it (`?retyped=1`), because a
          // heuristic that acts silently is indistinguishable from one that erred.
          retypedCount: countRetyped({ dbPath }),
        }
        // "Only flagged" is a filter over plugin state, so it is resolved here and
        // turned into an id list the store can answer.
        if (query?.flagged === '1' || query?.flagged === 'true') {
          const ids = flaggedIds(flagsNow)
          if (ids.length === 0) {
            return { rows: [], total: 0, limit: 0, offset: 0, order: 'created', applied: { ids: [] }, mode: 'substring', ...extra }
          }
          return { ...readMemories({ dbPath, query: { ...query, ids: ids.join(',') } }), ...extra }
        }
        return { ...readMemories({ dbPath, query }), ...extra }
      },
      readProvenance: (id) => readMemoryProvenance({ dbPath, id }),
      // Flagging writes this plugin's own state file: the store is untouched, so
      // the panel keeps its "it never modifies your memories" promise.
      writeFlag: panelWrites
        ? ({ id, flagged, note }) => {
          flags = setFlag(flags, id, flagged, { note })
          const saved = saveState(extract.statePath, {
            watermarks, diagnostics, pending, flags, inputs, produced: producedIndex,
          })
          return { ok: true, flags, flaggedCount: Object.keys(flags).length, persisted: saved }
        }
        : null,
      /**
       * The review queue: every flagged memory with its provenance, its window, and
       * whether that window can still be replayed.
       *
       * Bounded because each item costs a provenance read (three queries).
       */
      readReview: () => {
        const flagsNow = normalizeFlags(flags)
        const ids = flaggedIds(flagsNow).slice(0, MAX_REVIEW_ITEMS)
        if (ids.length === 0) return { items: [], total: 0, truncated: false, request: '' }
        const rows = readMemories({ dbPath, query: { ids: ids.join(','), limit: MAX_REVIEW_ITEMS } })
        const byId = new Map(rows.rows.map((row) => [row.id, row]))
        const items = ids
          .map((id) => {
            const row = byId.get(id)
            // A flag can outlive the memory it points at; drop those from the queue
            // (the flag map keeps them until cleared, which is not this route's job).
            if (row === undefined) return null
            const provenance = readMemoryProvenance({ dbPath, id })
            const window = producedIndex[id] ?? null
            const replayable = window?.inputKey != null && Object.hasOwn(inputs, window.inputKey)
            return {
              ...shapeReviewItem({ row, flag: flagsNow[id], window, provenance, replayable }),
              // Only for replayable items, and only a handful exist (MAX_INPUTS), so
              // the editor can be prefilled without shipping the whole history.
              ...(replayable ? { inputText: inputs[window.inputKey].text } : {}),
            }
          })
          .filter(Boolean)
        return {
          items,
          total: items.length,
          truncated: flaggedIds(flagsNow).length > MAX_REVIEW_ITEMS,
          // Ready to hand to a model: this is the plugin's half of "the model
          // proposes, the human approves".
          request: buildReviewRequest(items),
        }
      },
      /**
       * Replay a retained input — the panel's one action that writes the store, and
       * it does so through MemVault's own `add()`, never around it.
       */
      replay: panelWrites
        ? ({ input }) => {
          const valid = validateReplay(input, { inputs, minTranscriptChars: extract.minTranscriptChars })
          if (!valid.ok) return { ok: false, status: valid.status, error: valid.error }
          const entry = valid.entry
          enqueue(() => extractTranscript(entry.sessionId ?? 'replay', {
            text: valid.text,
            turns: entry.turns ?? 0,
            seq: null,
            replayOf: valid.key,
            env: valid.env,
          }))
          return { ok: true, key: valid.key, queued: true, extractor: valid.extractor }
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
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: MEMORY_PATH,
      handler: api.memory,
    }), 'dsh-memvault: panel memory provenance route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: FLAG_PATH,
      handler: api.flag,
    }), 'dsh-memvault: panel review flag route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: REVIEW_PATH,
      handler: api.review,
    }), 'dsh-memvault: panel review queue route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: REPLAY_PATH,
      handler: api.replay,
    }), 'dsh-memvault: panel replay route')
    panelCtx.effect(() => panelCtx.webServer.register({
      kind: 'exact',
      path: STRUCTURE_PATH,
      handler: api.structure,
    }), 'dsh-memvault: panel structure route')
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
   * The one place that talks to MemVault for extraction — a window, a window
   * recovered from the state file after a restart, or a replay a human asked for.
   */
  async function extractTranscript(sessionId, { text, turns, seq, recovered = false, replayOf = null, env = {} }) {
    if (seq !== null && seq !== undefined) watermarks.set(sessionId, seq)

    // Retain the input BEFORE sending it: a run that fails is exactly the one a
    // human may want to retry (or fix and retry).
    const inputKey = `${String(sessionId).slice(-8)}@${seq ?? 'x'}`
    if (replayOf === null && text.trim() !== '') {
      inputs = storeInput(inputs, inputKey, { text, seq, sessionId, turns })
    }

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
      config: { ...extract, env: { ...childEnv, ...env } },
      messages: [{ role: 'user', content: text }],
    })
    const at = new Date().toISOString()
    diagnostics.push({
      at,
      seq,
      turns,
      transcriptChars: text.length,
      outcome: result.ok ? `ok added=${result.added ?? 0}` : `failed: ${result.error}`,
      // What this window actually produced, so "was this extraction any good?" has
      // a link back to the rows instead of only a count.
      ...(result.ok && result.produced?.length ? { produced: result.produced } : {}),
      ...(recovered ? { recovered: true } : {}),
      ...(replayOf === null ? { inputKey } : { replayOf }),
    })
    if (diagnostics.length > 5) diagnostics.shift()
    // The reverse index: a stored memory stays traceable to its window even after
    // this diagnostic rolls out of the last-five window.
    if (result.ok && result.produced?.length) {
      producedIndex = recordProduced(producedIndex, result.produced, {
        at, seq, sessionId, inputKey: replayOf ?? inputKey, ...(replayOf === null ? {} : { replayOf }),
      })
    }
    clearPending(sessionId)
    saveState(extract.statePath, {
      watermarks, diagnostics, pending, flags, inputs, produced: producedIndex,
    })

    if (result.ok) {
      ctx.logger?.info?.(
        `dsh-memvault: extracted ${result.added ?? 0} memory item(s) from ${turns} turn(s)${recovered ? ' (recovered window)' : ''}${replayOf === null ? '' : ' (replay)'}`,
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
