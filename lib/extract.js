/**
 * Turn/end auto-extraction: hand each finished turn to MemVault, which runs its
 * own pipeline (LLM fact extraction → ADD/UPDATE/DELETE → embeddings).
 *
 * Transport: spawn the MemVault CLI with `add --stdin`.
 *
 *   - Not REST (`POST /api/v1/memories/`): that requires the FastAPI server to be
 *     running on 8780. Memory capture should not silently stop because a second
 *     process happens to be down.
 *   - Not a direct SQLite write: that skips extraction and embeddings entirely
 *     and would produce rows that retrieval cannot score.
 *   - `--stdin` rather than argv because a turn transcript blows past the OS
 *     command-line length limit.
 *
 * The cost is one Python process per extracted turn. That is why extraction is
 * throttled (`everyNTurns`) and why a trivial turn is skipped before spawning.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where the per-session extraction watermark lives (survives a DSH restart). */
export const DEFAULT_STATE_PATH = join(homedir(), '.dsh', 'storages', 'dsh-memvault-state.json')

const TOOL_ARGS_BUDGET = 200
const TOOL_RESULT_BUDGET = 400

/** Text of a content block, or undefined for non-text blocks (images, etc). */
function blockText(block) {
  if (typeof block === 'string') return block
  if (block && block.type === 'text' && typeof block.text === 'string') return block.text
  return undefined
}

/**
 * Render an event span as a bounded transcript, newest content kept.
 *
 * Event shapes follow the harness session log: `user/message` carries
 * `data.content[]`, `assistant/message` carries `data.message.content[]`,
 * tool calls carry `data.name` / `data.arguments`.
 *
 * @param events - session events, seq ascending.
 * @param maxChars - hard budget; the oldest lines are dropped first.
 */
export function renderTranscript(events, maxChars = 6000, { includeAssistant = false, includeTools = false } = {}) {
  const lines = []
  for (const event of events) {
    // User turns only by default: they carry the facts worth storing. Shipping the
    // assistant's own prose produced noise — measured in production, the extractor
    // stored "智能体运行在 DSH 上" / "模型是 deepseek-v4-flash" because it does not
    // separate roles. Tool traffic is off for the same reason (and eats the budget).
    if (!includeAssistant && event.type === 'assistant/message') continue
    if (!includeTools && (event.type === 'tool/call' || event.type === 'tool/result')) continue
    if (event.type === 'user/message') {
      for (const block of event.data?.content ?? []) {
        const text = blockText(block)
        if (text) lines.push(`用户: ${text}`)
      }
    } else if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        const text = blockText(block)
        if (text) lines.push(`助手: ${text}`)
      }
    } else if (event.type === 'tool/call') {
      const args = String(event.data?.arguments ?? '').slice(0, TOOL_ARGS_BUDGET)
      lines.push(`工具调用: ${event.data?.name ?? ''}(${args})`)
    } else if (event.type === 'tool/result') {
      const text = blockText(event.data?.message?.content?.[0])
      if (text) lines.push(`工具结果: ${text.slice(0, TOOL_RESULT_BUDGET)}`)
    }
  }
  let text = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = `${lines[i]}\n${text}`
    if (candidate.length > maxChars) break
    text = candidate
  }
  return text.trim()
}

/**
 * Slice the events of the turn that just ended.
 *
 * Deliberately **not** seq arithmetic. `session.events[].seq` is the log *index*
 * (`dsh-session` appends `seq: SessionSeq(this.log.length)`), and comparing a
 * persisted watermark against it can collapse the window to zero events, which
 * silently disables extraction — observed in production as `after === endSeq` on
 * every turn, with the store never growing.
 *
 * The turn boundary defines the span, so this is idempotent (a duplicate
 * `turn/end` yields the same slice), restart-proof (no state to go stale), and
 * needs no watermark at all.
 *
 * @param events - the session's event list.
 * @param endEvent - the `turn/end` event that just fired.
 * @returns the events of that turn, oldest first.
 */
export function turnSpanByBoundary(events, endEvent) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return []
  let end = list.lastIndexOf(endEvent)
  if (end < 0) end = list.length - 1
  let start = 0
  for (let i = end - 1; i >= 0; i--) {
    if (list[i]?.type === 'turn/end') { start = i + 1; break }
  }
  return list.slice(start, end + 1)
}

/**
 * Bounded per-session event buffer.
 *
 * Why this exists: `session.events` is **not an array** on the object handed to
 * `ctx.on('session/event')` handlers — measured in production, `Array.isArray`
 * is false, so every slice came out empty and extraction silently never ran
 * (diagnostics showed `events: 0` on every turn, across two different slice
 * strategies in a row).
 *
 * Observers are invoked for *every* appended event, so the plugin keeps its own
 * bounded log per session: the data it actually receives, instead of an assumed
 * facade. Bounded on both axes so a long-lived host cannot grow without limit.
 */
export function createEventBuffer({ maxPerSession = 400, maxSessions = 32 } = {}) {
  const byId = new Map()
  return {
    /** Append one event; returns the session's buffer after the append. */
    push(sessionId, event) {
      let list = byId.get(sessionId)
      if (list === undefined) {
        list = []
        byId.set(sessionId, list)
        if (byId.size > maxSessions) byId.delete(byId.keys().next().value)
      }
      list.push(event)
      if (list.length > maxPerSession) list.splice(0, list.length - maxPerSession)
      return list
    },
    get(sessionId) {
      return byId.get(sessionId) ?? []
    },
  }
}

/**
 * Load the whole state file: `{ watermarks, diagnostics }`.
 *
 * `diagnostics` is the last few extraction attempts the previous process wrote.
 * They are loaded (not just appended to) so the panel can show history across a
 * DSH restart — otherwise every restart would look like "extraction never ran".
 * A missing or corrupt file yields empty defaults.
 */
export function loadState(statePath = DEFAULT_STATE_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    const diagnostics = Array.isArray(parsed?.diagnostics) ? parsed.diagnostics.slice(-5) : []
    return { watermarks: new Map(Object.entries(parsed?.watermarks ?? {})), diagnostics }
  } catch {
    return { watermarks: new Map(), diagnostics: [] }
  }
}

/** Load `{ sessionId: lastSeq }`; a missing or corrupt file yields an empty map. */
export function loadWatermarks(statePath = DEFAULT_STATE_PATH) {
  return loadState(statePath).watermarks
}

/**
 * Persist the watermark map atomically (tmp + rename, so a crash mid-write cannot
 * leave a truncated file that would lose every session's position).
 *
 * `diagnostics` (optional) rides along in the same file so the outside world can
 * tell "the hook never fired" from "the hook fired and the turn was too short"
 * from "extraction ran and found nothing" — three states that all leave the store
 * unchanged but mean completely different things.
 */
export function saveWatermarks(map, statePath = DEFAULT_STATE_PATH, diagnostics = null) {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const tmp = `${statePath}.tmp`
    const payload = { watermarks: Object.fromEntries(map) }
    if (diagnostics) payload.diagnostics = diagnostics
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, statePath)
    return true
  } catch {
    return false // non-fatal: worst case a turn is re-mined later
  }
}

/** argv for the MemVault CLI call. */
export function buildAddInvocation({ pythonPath, projectDir, user, agent, run }) {
  const args = ['-m', 'memvault.cli', 'add', '--stdin']
  if (user) args.push('--user', user)
  if (agent) args.push('--agent', agent)
  if (run) args.push('--run', run)
  return { command: pythonPath, args, cwd: projectDir }
}

/**
 * Feed `messages` to MemVault and resolve with the parsed result.
 *
 * Never rejects and never throws into the caller: memory capture is a
 * side-channel and must not break a turn.
 *
 * @returns {Promise<{ok: boolean, added?: number, error?: string}>}
 */
export function runExtraction({ config, messages, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const { command, args, cwd } = buildAddInvocation(config)
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: `spawn failed: ${error.message}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ ok: false, error: `timed out after ${config.timeoutMs}ms` })
    }, config.timeoutMs ?? 120_000)

    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code !== 0) {
        // Keep the TAIL: a Python traceback puts the actual exception last, and
        // keeping the head left earlier failures unreadable.
        finish({ ok: false, error: `exit ${code}: ${stderr.trim().slice(-900)}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        finish({ ok: true, added: parsed.results?.length ?? 0, relations: parsed.relations?.length ?? 0 })
      } catch {
        finish({ ok: true, added: 0 })
      }
    })

    try {
      child.stdin?.end(JSON.stringify(messages))
    } catch (error) {
      finish({ ok: false, error: `stdin failed: ${error.message}` })
    }
  })
}
