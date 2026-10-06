/**
 * The two mistakes this stretch made, as assertions.
 *
 * Both were the same shape: a value was produced on one side of a boundary and never carried
 * across it. `pendingStats` was wired into the plugin but not into the status payload, and the
 * reindex handler was passed into `createPanelApi` but not returned by it - so the route
 * registered a handler that did not exist and answered nothing. Neither showed up in any
 * suite, because every suite tested the halves separately.
 */
import { buildStatus, createPanelApi } from '../lib/panel.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[PASS] ${name}${detail ? ` -- ${detail}` : ''}`)
  else { failures += 1; console.log(`[FAIL] ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── createPanelApi must RETURN every handler it accepts ──────────────────────
{
  const api = createPanelApi({
    status: () => ({}),
    refresh: () => ({}),
    flush: () => ({ flushed: 0 }),
    reindex: () => ({ ok: true, report: { total: 0 } }),
  })
  check('the panel api returns the reindex handler it was given', typeof api.reindex === 'function',
    Object.keys(api).join(','))
  check('it still returns the handlers it always did',
    ['status', 'refresh', 'flush', 'blocks', 'memories', 'memory', 'flag', 'review', 'replay', 'structure']
      .every((key) => key in api))

  // and the returned handler is a real (req, res) handler that reads its own body
  const reply = await new Promise((resolve) => {
    const res = { writeHead: () => {}, end: (body) => resolve(body) }
    api.reindex({ method: 'GET', headers: { host: '127.0.0.1:19387' } }, res).then(() => {})
    setTimeout(() => resolve('timeout'), 500)
  })
  check('a GET on the reindex route is refused rather than answered',
    String(reply).includes('405') || String(reply).includes('POST only'),
    String(reply).slice(0, 80))
}

// ── buildStatus must CARRY the counters it is handed ────────────────────────
{
  const dropped = { overCap: 2, expired: 1, maxPendingSessions: 40, maxPendingAgeMs: 3_600_000 }
  const payload = buildStatus({ paths: [], extract: { pendingWindows: [], pendingStats: dropped } })
  check('the status payload carries pendingDropped', payload?.extract?.window?.pendingDropped?.overCap === 2,
    JSON.stringify(payload?.extract?.window?.pendingDropped))

  const without = buildStatus({ paths: [], extract: { pendingWindows: [] } })
  check('and says null rather than throwing when the plugin has no window',
    without?.extract?.window?.pendingDropped === null)
}

console.log(failures === 0 ? 'panel routes: all checks passed' : `panel routes: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
