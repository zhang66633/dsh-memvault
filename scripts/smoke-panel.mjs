/**
 * Smoke test for the panel — both halves, with no DSH and no browser.
 *
 *   node scripts/smoke-panel.mjs
 *
 * Three things are actually exercised:
 *
 *   1. the host half mounts on a stub cordis context, registers a
 *      `systemPrompt.context` contribution and both exact routes;
 *   2. the routes answer real data from a **throwaway** database — including the
 *      point of the refresh button: with the TTL still warm the status is stale,
 *      and `POST /refresh` picks up a row written in between;
 *   3. the shipped client bundle is executable: the factory runs under a stub
 *      ModuleLoader/React/slots, and `apply()` registers the panel in both slots.
 *
 * It also fails when `lib/client.js` does not match `src/client/index.js`, so a
 * stale panel cannot ship.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { BLOCK_VALUE_MAX, REFRESH_PATH, STATUS_PATH, buildStatus, createPanelApi, isTrustedRequest } from '../lib/panel.js'
import { loadState, saveWatermarks } from '../lib/extract.js'
import { apply as applyHost, name as hostName } from '../lib/index.js'
import { wrapClientBundle } from './build-client.mjs'

const failures = []
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// ── request trust ────────────────────────────────────────────────────────────
check('loopback host is trusted', isTrustedRequest({ host: '127.0.0.1:19387' }))
check('localhost with no port is trusted', isTrustedRequest({ host: 'localhost' }))
check('matching origin is trusted', isTrustedRequest({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }))
check('a foreign host is refused', !isTrustedRequest({ host: 'evil.example' }))
check('a foreign origin is refused', !isTrustedRequest({ host: '127.0.0.1:19387', origin: 'http://evil.example' }))
check('a cross-site fetch is refused', !isTrustedRequest({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' }))
check('a missing host is refused', !isTrustedRequest({}))

// ── payload shaping ──────────────────────────────────────────────────────────
{
  const long = 'x'.repeat(3000)
  const payload = buildStatus({
    read: { dbPath: 'D:/x.db', scopes: [{ type: 'user', id: 'lenovo' }], blockCount: 1 },
    blocks: [{ scopeType: 'user', scopeId: 'lenovo', label: 'big', value: long }],
    extract: { everyNTurns: 3 },
  })
  check('scopes are flattened for display', payload.read.scopes[0] === 'user/lenovo')
  check('a long block keeps its true length but ships a clamped value',
    payload.blocks[0].chars === 3000 && payload.blocks[0].value.length === BLOCK_VALUE_MAX + 1,
    `chars=${payload.blocks[0].chars} shipped=${payload.blocks[0].value.length}`)
  check('an empty snapshot still has both halves', !!payload.read && !!payload.extract)
}

// ── handler behaviour (trust, method, errors) ────────────────────────────────
{
  const calls = []
  const api = createPanelApi({
    status: () => { calls.push('status'); return { at: 'x', read: {}, blocks: [], extract: {} } },
    refresh: () => { calls.push('refresh'); return { at: 'y', read: {}, blocks: [], extract: {} } },
  })
  const res = () => {
    const out = { code: null, body: null, headers: null }
    return {
      out,
      writeHead(code, headers) { out.code = code; out.headers = headers },
      end(body) { out.body = JSON.parse(body) },
    }
  }
  const req = (headers, method = 'GET') => ({ headers, method })

  const okRes = res()
  await api.status(req({ host: '127.0.0.1:19387' }), okRes)
  check('GET status answers ok', okRes.out.code === 200 && okRes.out.body.ok === true, `code=${okRes.out.code}`)
  check('the panel response is never cached', okRes.out.headers['cache-control'] === 'no-store')

  const untrusted = res()
  await api.status(req({ host: 'evil.example' }), untrusted)
  check('an untrusted host gets 403 with no payload',
    untrusted.out.code === 403 && untrusted.out.body.ok === false)

  const wrongMethod = res()
  await api.refresh(req({ host: '127.0.0.1:19387' }), wrongMethod)
  check('refresh rejects GET with 405', wrongMethod.out.code === 405)

  const post = res()
  await api.refresh(req({ host: '127.0.0.1:19387' }, 'POST'), post)
  check('POST refresh answers ok', post.out.code === 200 && post.out.body.at === 'y')
  check('only the refresh handler ran for the refresh route', calls.join(',') === 'status,refresh')

  const boom = createPanelApi({ status: () => { throw new Error('nope') }, refresh: () => ({}) })
  const failed = res()
  await boom.status(req({ host: '127.0.0.1:19387' }), failed)
  check('a throwing status becomes a 500, never an unhandled rejection',
    failed.out.code === 500 && failed.out.body.error === 'nope')
}

// ── the real thing: mount on a stub cordis ctx against a throwaway db ────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-memvault-panel-'))
try {
  const dbPath = join(dir, 'panel.db')
  const statePath = join(dir, 'state.json')

  const seed = (rows) => {
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE IF NOT EXISTS blocks (scope_type TEXT, scope_id TEXT, label TEXT, value TEXT, position INTEGER)')
    for (const r of rows) db.prepare('INSERT INTO blocks (scope_type, scope_id, label, value, position) VALUES (?,?,?,?,?)')
      .run(r.scopeType, r.scopeId, r.label, r.value, r.position ?? 0)
    db.close()
  }
  seed([
    { scopeType: 'user', scopeId: 'lenovo', label: 'human', value: '名字是哲。', position: 0 },
    { scopeType: 'agent', scopeId: 'claude-code-memory', label: 'role', value: '名字是余。', position: 0 },
  ])
  saveWatermarks(new Map([['sess-a', 10], ['sess-b', 20]]), statePath, [
    { at: '2026-09-28T10:00:00.000Z', seq: 10, transcriptChars: 120, outcome: 'ok added=1' },
  ])

  const contexts = []
  const routes = new Map()
  const children = []
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) { return fn() },
    on() {},
    systemPrompt: { context(spec) { contexts.push(spec); return () => {} } },
    inject(deps, callback) { children.push({ deps, callback }) },
  }
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const childCtx = { effect: ctx.effect, webServer }

  applyHost(ctx, {
    dbPath,
    scopes: [{ type: 'user', id: 'lenovo' }, { type: 'agent', id: 'claude-code-memory' }],
    extract: { enabled: true, everyNTurns: 3, statePath },
  })

  check('plugin name matches the package', hostName === 'dsh-memvault', hostName)
  check('a systemPrompt runtime context is registered',
    contexts.length === 1 && contexts[0].name === 'memvault:core' && typeof contexts[0].text === 'function',
    contexts.map((c) => c.name).join(','))
  const injected = contexts[0].text()
  check('the injected text carries both blocks and the attribution header',
    injected.includes('[user/lenovo/human]') && injected.includes('[agent/claude-code-memory/role]')
    && injected.startsWith('MemVault core memory'),
    `${injected.length} chars`)
  check('the webServer child plugin is requested, not required',
    children.length === 1 && children[0].deps.join(',') === 'webServer', JSON.stringify(children.map((c) => c.deps)))

  children[0].callback(childCtx)
  check('both exact routes are registered',
    routes.has(STATUS_PATH) && routes.has(REFRESH_PATH), [...routes.keys()].join(', '))

  const call = async (path, method = 'GET') => {
    const out = { code: null, body: null }
    const res = { writeHead(code) { out.code = code }, end(body) { out.body = JSON.parse(body) } }
    await routes.get(path).handler({ headers: { host: '127.0.0.1:19387' }, method }, res)
    return out
  }

  const first = await call(STATUS_PATH)
  check('GET status returns ok with real blocks',
    first.code === 200 && first.body.ok === true && first.body.read.blockCount === 2,
    `blocks=${first.body.read.blockCount}`)
  check('the payload carries the blocks the prompt got',
    first.body.blocks.map((b) => `${b.scope}/${b.label}`).join(',') === 'user/lenovo/human,agent/claude-code-memory/role')
  check('extraction state is reported, including persisted diagnostics',
    first.body.extract.sessions === 2 && first.body.extract.diagnostics[0].outcome === 'ok added=1'
    && first.body.extract.everyNTurns === 3,
    `sessions=${first.body.extract.sessions} diag=${first.body.extract.diagnostics.length}`)
  check('the read half reports its budget and TTL',
    first.body.read.maxChars === 4000 && first.body.read.refreshMs === 30000)

  // A row written now must NOT appear while the render TTL is warm …
  seed([{ scopeType: 'user', scopeId: 'lenovo', label: 'persona', value: '协作风格：简练。', position: 1 }])
  const warm = await call(STATUS_PATH)
  check('a warm TTL serves the cached render', warm.body.read.blockCount === 2, `blocks=${warm.body.read.blockCount}`)

  // … and POST /refresh must bypass it.
  const forced = await call(REFRESH_PATH, 'POST')
  check('POST refresh bypasses the TTL and picks the new block up',
    forced.body.read.blockCount === 3 && forced.body.blocks.some((b) => b.label === 'persona'),
    `blocks=${forced.body.read.blockCount}`)
  check('the refreshed text is what the prompt will inject next',
    contexts[0].text().includes('[user/lenovo/persona]'))

  // A broken store degrades, it does not throw.
  const brokenCtx = { ...ctx, systemPrompt: { context(spec) { contexts.push(spec); return () => {} } } }
  const brokenChildren = []
  applyHost({ ...brokenCtx, inject: (deps, cb) => brokenChildren.push({ deps, cb }) }, {
    dbPath: join(dir, 'missing.db'),
    extract: { enabled: false, statePath: join(dir, 'missing-state.json') },
  })
  const brokenRoutes = new Map()
  brokenChildren[0].cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { brokenRoutes.set(r.path, r); return () => {} } },
  })
  const broken = await (async () => {
    const out = { code: null, body: null }
    await brokenRoutes.get(STATUS_PATH).handler(
      { headers: { host: '127.0.0.1:19387' }, method: 'GET' },
      { writeHead(code) { out.code = code }, end(body) { out.body = JSON.parse(body) } },
    )
    return out
  })()
  check('an unreadable store still answers 200 and reports the error',
    broken.code === 200 && broken.body.read.blockCount === 0
    && typeof broken.body.read.error === 'string' && broken.body.read.error.length > 0,
    String(broken.body.read.error).slice(0, 60))
  check('the panel works with extraction disabled', broken.body.extract.enabled === false)

  check('loadState round-trips watermarks and diagnostics',
    loadState(statePath).watermarks.size === 2 && loadState(statePath).diagnostics.length === 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── the shipped browser bundle ───────────────────────────────────────────────
{
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const shipped = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  check('lib/client.js is exactly what src/client/index.js builds to',
    wrapClientBundle(source) === shipped,
    'run `npm run build:client`')

  let registration = null
  const requireStub = (id) => {
    if (id === 'react') return { createElement: (type, props, ...kids) => ({ type, props, kids }) }
    throw new Error(`unexpected require(${id})`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { registration = spec } } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, read: {}, blocks: [], extract: {} }) }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    Date,
    Math,
    JSON,
    Promise,
  }
  sandbox.globalThis = sandbox
  runInContext(shipped, createContext(sandbox), { filename: 'lib/client.js' })

  check('the bundle registers a ModuleLoader factory',
    registration !== null && typeof registration.factory === 'function', String(registration?.id))
  check('the bundle id is the package name', registration?.id === 'dsh-memvault', String(registration?.id))

  const client = registration.factory(requireStub)
  check('the client half exports name / inject / apply',
    client.name === 'dsh-memvault' && Array.isArray(client.inject)
    && client.inject.join(',') === 'slots' && typeof client.apply === 'function',
    `${client.name} inject=${client.inject}`)

  const registered = []
  client.apply({
    slots: {
      inject(slot, callback) { callback() },
      register(config, component) { registered.push({ config, component }); return () => {} },
    },
  })
  check('the panel registers in the conversation ring and the Plugins settings tab',
    registered.length === 2
    && registered.map((r) => r.config.name).join(',') === 'conversation.view,settings.plugins.tab'
    && registered.every((r) => r.config.id === 'memvault' && typeof r.config.label() === 'string'),
    registered.map((r) => `${r.config.name}#${r.config.id}`).join(', '))
  check('both registrations render a React component',
    registered.every((r) => typeof r.component === 'function'))
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
