/**
 * Smoke test for the extraction half: transcript rendering, the watermark store,
 * and a REAL end-to-end write through the MemVault CLI.
 *
 *   node scripts/smoke-extract.mjs
 *
 * The end-to-end step runs against a throwaway db with the offline embedder and
 * rule extractor forced in, so it never touches the real store and never calls
 * the remote gateway configured in the project .env.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAddInvocation,
  createEventBuffer,
  loadWatermarks,
  renderTranscript,
  runExtraction,
  saveWatermarks,
  turnSpanByBoundary,
} from '../lib/extract.js'
import { DEFAULT_EXTRACT } from '../lib/index.js'
import { DEFAULT_WINDOW, createTurnWindow } from '../lib/window.js'

const failures = []
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── createEventBuffer (the plugin's own event log) ───────────────────────────
{
  const buf = createEventBuffer({ maxPerSession: 3, maxSessions: 2 })
  for (const seq of [1, 2, 3, 4]) buf.push('a', { seq })
  check('buffer keeps only the newest maxPerSession',
    buf.get('a').map((e) => e.seq).join(',') === '2,3,4', buf.get('a').map((e) => e.seq).join(','))
  check('buffer returns [] for an unknown session', buf.get('nope').length === 0)
  const bounded = createEventBuffer({ maxSessions: 1 })
  bounded.push('a', { seq: 1 })
  bounded.push('b', { seq: 1 })
  check('buffer evicts the oldest session', bounded.get('a').length === 0 && bounded.get('b').length === 1)
}

// ── renderTranscript ──────────────────────────────────────────────────────────
const events = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '我喜欢吃辣的食物。' }] } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记下了。' }] } } },
  { seq: 3, type: 'tool/call', data: { name: 'memory_add', arguments: '{"messages":[]}' } },
  { seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '{"results":[]}' }] } } },
  { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'image', data: 'x' }] } } },
]
const rendered = renderTranscript(events, 6000)
const renderedAll = renderTranscript(events, 6000, { includeAssistant: true, includeTools: true })
console.log('--- rendered (default: user only) ---\n' + rendered + '\n----------------')
check('default keeps user text', rendered.includes('用户: 我喜欢吃辣的食物。'))
check('default drops assistant prose (role filtering)',
  !rendered.includes('助手: 记下了。'))
check('default drops tool traffic', !rendered.includes('工具调用:') && !rendered.includes('工具结果:'))
check('opting in restores assistant + tools',
  renderedAll.includes('助手: 记下了。') && renderedAll.includes('工具调用: memory_add')
  && renderedAll.includes('工具结果:'))
check('skips non-text blocks', !rendered.includes('image'))
check('honours the char budget', renderTranscript(events, 30).length <= 30,
  `len=${renderTranscript(events, 30).length} of 30`)

// ── turnSpanByBoundary (replaces the seq-window slice) ───────────────────────
const turnEvents = [
  { seq: 0, type: 'turn/start' },
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '第一轮的话' }] } },
  { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '第二轮的话' }] } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回复' }] } } },
  { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
]
const lastEnd = turnEvents[5]
const span = turnSpanByBoundary(turnEvents, lastEnd)
check('boundary span covers only the last turn', span.map((e) => e.seq).join(',') === '3,4,5',
  span.map((e) => e.seq).join(','))
const spanText = renderTranscript(span, 6000)
check('boundary span excludes the previous turn',
  spanText.includes('第二轮的话') && !spanText.includes('第一轮的话'))
check('duplicate turn/end is idempotent',
  turnSpanByBoundary(turnEvents, lastEnd).map((e) => e.seq).join(',') === '3,4,5')
check('unknown end event falls back to the tail',
  turnSpanByBoundary(turnEvents, { seq: 99, type: 'turn/end' }).map((e) => e.seq).join(',') === '3,4,5')
check('empty event list yields an empty span', turnSpanByBoundary([], lastEnd).length === 0)
check('a first turn with no earlier turn/end starts at 0',
  turnSpanByBoundary(turnEvents.slice(0, 3), turnEvents[2]).map((e) => e.seq).join(',') === '0,1,2')

// ── watermark store ──────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-memvault-'))
try {
  const statePath = join(dir, 'state.json')
  check('missing state file reads as empty', loadWatermarks(statePath).size === 0)
  const map = new Map([['sess-1', 42]])
  check('watermark save succeeds', saveWatermarks(map, statePath) === true)
  check('watermark round-trips', loadWatermarks(statePath).get('sess-1') === 42)

  // ── invocation ─────────────────────────────────────────────────────────────
  const inv = buildAddInvocation({ pythonPath: 'py.exe', projectDir: 'D:/x', user: 'u', agent: 'a' })
  check('invocation uses add --stdin with scope flags',
    inv.args.join(' ') === '-m memvault.cli add --stdin --user u --agent a' && inv.cwd === 'D:/x',
    inv.args.join(' '))

  // ── REAL end-to-end write, throwaway db ────────────────────────────────────
  const dbPath = join(dir, 'e2e.db')
  const result = await runExtraction({
    config: {
      ...DEFAULT_EXTRACT,
      env: {
        MEMVAULT_DB_PATH: dbPath,
        MEMVAULT_EMBEDDER: 'local',
        MEMVAULT_EXTRACTOR: 'rule',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    },
    messages: [{ role: 'user', content: rendered }],
  })
  console.log('extraction result:', JSON.stringify(result))
  check('extraction reports success', result.ok === true, result.error ?? '')
  check('extraction wrote memories', (result.added ?? 0) >= 1, `added=${result.added}`)

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT memory FROM memories').all()
  db.close()
  console.log('rows written:', JSON.stringify(rows.map((r) => r.memory)))
  check('the fact landed in the store', rows.some((r) => r.memory.includes('喜欢吃辣')))
  check('rows carry an embedding (pipeline ran, not a raw insert)',
    (() => {
      const d = new DatabaseSync(dbPath, { readOnly: true })
      const n = d.prepare('SELECT COUNT(*) c FROM memories WHERE embedding IS NOT NULL').get().c
      d.close()
      return n >= 1
    })())

  // ── failure path ───────────────────────────────────────────────────────────
  const bad = await runExtraction({
    config: { ...DEFAULT_EXTRACT, pythonPath: 'D:/nonexistent/python.exe', timeoutMs: 5000, env: {} },
    messages: [{ role: 'user', content: 'x' }],
  })
  check('a broken python path fails soft, never throws', bad.ok === false && typeof bad.error === 'string',
    bad.error?.slice(0, 60) ?? '')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── the turn window: when a flush happens (fake timers, no clock) ────────────
{
  const makeClock = () => {
    let nextId = 1
    const timers = new Map()
    return {
      timers,
      setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, ms }); return id },
      clearTimer(id) { timers.delete(id) },
      fire(id) { const t = timers.get(id); timers.delete(id); t.fn() },
      only() { return [...timers.keys()][0] },
    }
  }
  const turn = (seq) => ({ seq, events: [{ seq }], at: new Date(seq * 1000).toISOString() })

  const clock = makeClock()
  const flushed = []
  const w = createTurnWindow({
    everyNTurns: 3, windowTurns: 5, idleMs: 1000,
    flush: (id, turns) => flushed.push({ id, turns: turns.length }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })

  check('below everyNTurns nothing is armed',
    w.push('a', turn(1)).action === 'waiting' && clock.timers.size === 0)
  check('the second turn still waits', w.push('a', turn(2)).action === 'waiting')
  const armed = w.push('a', turn(3))
  check('reaching everyNTurns arms the idle timer',
    armed.action === 'armed' && armed.turns === 3 && clock.timers.size === 1,
    JSON.stringify(armed))
  check('the timer waits idleMs', clock.timers.get(clock.only()).ms === 1000)
  check('the window reports what is pending',
    w.pending('a') === 3 && w.pendingWindows()[0].sessionId === 'a')

  const firstTimer = clock.only()
  const rearmed = w.push('a', turn(4))
  check('a new turn re-arms the timer instead of flushing early',
    rearmed.action === 'armed' && !clock.timers.has(firstTimer) && clock.timers.size === 1)
  check('nothing has been flushed yet', flushed.length === 0)

  const capped = w.push('a', turn(5))
  check('a full window flushes immediately, without waiting for idle',
    capped.action === 'flushed' && capped.turns === 5 && flushed.length === 1 && flushed[0].turns === 5,
    JSON.stringify(capped))
  check('a flush leaves nothing pending and no timer behind',
    w.pending('a') === 0 && clock.timers.size === 0)

  // Idle path: three turns, then quiet.
  w.push('a', turn(6))
  w.push('a', turn(7))
  w.push('a', turn(8))
  const idleTimer = clock.only()
  check('the idle path is armed again', idleTimer !== undefined)
  clock.fire(idleTimer)
  check('firing the idle timer flushes the window',
    flushed.length === 2 && flushed[1].turns === 3, JSON.stringify(flushed))
  check('the timed-out window is empty afterwards', w.pendingWindows().length === 0)

  // Per-session isolation.
  w.push('a', turn(9))
  w.push('b', turn(10))
  w.push('b', turn(11))
  w.push('b', turn(12))
  check('sessions keep separate windows',
    w.pending('a') === 1 && w.pending('b') === 3 && w.pendingWindows().length === 2,
    JSON.stringify(w.pendingWindows()))
  check('flushAll hands over every non-empty window', w.flushAll() === 2 && flushed.length === 4)
  check('flushNow on an empty window is a no-op', w.flushNow('zzz') === 0)

  // Disposal must not leave a timer that fires into a disposed plugin.
  w.push('a', turn(13))
  w.push('a', turn(14))
  w.push('a', turn(15))
  check('a window is armed before disposal', clock.timers.size === 1)
  w.dispose()
  check('dispose clears the timers and the windows',
    clock.timers.size === 0 && w.pendingWindows().length === 0)

  check('everyNTurns must be a positive integer',
    (() => { try { createTurnWindow({ everyNTurns: 0 }); return false } catch { return true } })())
  check('windowTurns must be a positive integer',
    (() => { try { createTurnWindow({ windowTurns: 0 }); return true } catch { return false } })() === false)
  check('the defaults are the documented ones',
    DEFAULT_WINDOW.everyNTurns === 3 && DEFAULT_WINDOW.idleMs === 20000 && DEFAULT_WINDOW.windowTurns === 8,
    JSON.stringify(DEFAULT_WINDOW))
}

// ── a window renders as one transcript ──────────────────────────────────────
{
  const turns = [
    { seq: 2, events: [
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '第一轮：用 SQLite。' }] } },
      { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] },
    { seq: 4, events: [
      { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '第二轮：只读打开。' }] } },
      { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] },
  ]
  const text = renderTranscript(turns.flatMap((t) => t.events), 6000)
  check('a window renders every turn in order',
    text.includes('第一轮：用 SQLite。') && text.includes('第二轮：只读打开。')
    && text.indexOf('第一轮') < text.indexOf('第二轮'),
    `${text.length} chars`)
  const capped = renderTranscript(turns.flatMap((t) => t.events), 20)
  check('the window transcript keeps the newest lines within budget',
    capped.length <= 20 && capped.includes('第二轮') && !capped.includes('第一轮'),
    `${capped.length} chars`)
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
