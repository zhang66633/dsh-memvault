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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import {
  BLOCKS_PATH,
  BLOCK_VALUE_CLAMP,
  MAX_BODY_BYTES,
  REFRESH_PATH,
  STATUS_PATH,
  buildStatus,
  createPanelApi,
  isTrustedRequest,
  readJsonBody,
} from '../lib/panel.js'
import {
  BLOCK_LABEL_MAX,
  BLOCK_VALUE_MAX,
  buildBlockDeleteArgs,
  buildBlockSetArgs,
  runBlockAction,
  validateBlockAction,
} from '../lib/blocks-write.js'
import { loadState, saveWatermarks } from '../lib/extract.js'
import { DEFAULT_EXTRACT, apply as applyHost, name as hostName } from '../lib/index.js'
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
    payload.blocks[0].chars === 3000 && payload.blocks[0].value.length === BLOCK_VALUE_CLAMP + 1,
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

// ── block-write validation and argv ─────────────────────────────────────────
{
  const base = { action: 'set', type: 'user', id: 'lenovo', label: 'persona', value: '喜欢结论先行' }
  check('a well-formed set passes', validateBlockAction(base).ok === true)
  check('delete passes without a value', validateBlockAction({ ...base, action: 'delete', value: undefined }).ok === true)
  check('an unknown action is refused', !validateBlockAction({ ...base, action: 'append' }).ok)
  check('an unknown scope type is refused', !validateBlockAction({ ...base, type: 'run' }).ok)
  check('a missing label is refused', !validateBlockAction({ ...base, label: '  ' }).ok)
  check('a multi-line label is refused', !validateBlockAction({ ...base, label: 'a\nb' }).ok)
  check('an over-long label is refused',
    !validateBlockAction({ ...base, label: 'x'.repeat(BLOCK_LABEL_MAX + 1) }).ok)
  check('an empty value is refused on set', !validateBlockAction({ ...base, value: '   ' }).ok)
  check('an over-long value is refused',
    !validateBlockAction({ ...base, value: 'x'.repeat(BLOCK_VALUE_MAX + 1) }).ok)
  check('a value on delete is refused', !validateBlockAction({ ...base, action: 'delete', value: 'x' }).ok)
  check('a non-integer limit is refused', !validateBlockAction({ ...base, limit: '2.5' }).ok)
  check('a valid limit is kept', validateBlockAction({ ...base, limit: 500 }).limit === 500)

  const setArgs = buildBlockSetArgs(validateBlockAction({ ...base, limit: 500 }))
  check('blocks-set argv puts the limit before `--` and the positionals after it',
    setArgs.join(' ') === 'blocks-set --type user --id lenovo --limit 500 -- persona 喜欢结论先行',
    setArgs.join(' '))
  const dashArgs = buildBlockSetArgs(validateBlockAction({ ...base, value: '--not-a-flag' }))
  check('a value that looks like an option stays data (`--` separator)',
    dashArgs.join(' ') === 'blocks-set --type user --id lenovo -- persona --not-a-flag',
    dashArgs.join(' '))
  check('blocks-delete argv needs no value',
    buildBlockDeleteArgs(validateBlockAction({ ...base, action: 'delete', value: undefined })).join(' ')
    === 'blocks-delete --type user --id lenovo -- persona')
}

// ── bounded JSON body reading ───────────────────────────────────────────────
{
  const streamOf = (chunks) => ({
    destroyed: false,
    on(event, handler) {
      if (event === 'data') for (const c of chunks) handler(c)
      if (event === 'end') handler()
    },
    destroy() { this.destroyed = true },
  })
  check('a JSON object body parses',
    (await readJsonBody(streamOf(['{"action":"set"}']))).body.action === 'set')
  check('an empty body is an empty object',
    JSON.stringify((await readJsonBody(streamOf([]))).body) === '{}')
  check('a JSON array is refused as a non-object',
    typeof (await readJsonBody(streamOf(['[1,2]']))).error === 'string')
  check('a malformed body yields an error, not a throw',
    typeof (await readJsonBody(streamOf(['{oops']))).error === 'string')
  const big = await readJsonBody(streamOf(['x'.repeat(MAX_BODY_BYTES + 10)]))
  check('an over-sized body is flagged and the stream destroyed', big.tooLarge === true)
  check('a request with no stream still answers an object',
    JSON.stringify((await readJsonBody({})).body) === '{}')
  const res = { code: null, body: null }
  await createPanelApi({ status: () => ({}), refresh: () => ({}), writeBlock: async () => ({ ok: false, status: 400, error: 'bad' }) })
    .blocks({ headers: { host: '127.0.0.1:19387' }, method: 'POST' },
      { writeHead(code) { res.code = code }, end(p) { res.body = JSON.parse(p) } })
  check('a rejected write reaches the caller with its status',
    res.code === 400 && res.body.ok === false, `code=${res.code}`)
}

// ── the real thing: mount on a stub cordis ctx against a throwaway db ────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-memvault-panel-'))
try {
  const dbPath = join(dir, 'panel.db')
  const statePath = join(dir, 'state.json')

  // Seed through the CLI rather than by hand: the temp database then has the
  // schema MemVault itself creates, and MEMVAULT_DB_PATH overriding the project
  // .env is exercised before anything reads.
  const cliConfig = {
    pythonPath: DEFAULT_EXTRACT.pythonPath,
    projectDir: DEFAULT_EXTRACT.projectDir,
    env: { ...DEFAULT_EXTRACT.env, MEMVAULT_DB_PATH: dbPath },
    timeoutMs: 120000,
  }
  const setViaCli = (input) => runBlockAction({ config: cliConfig, input })
  const seeded = await setViaCli({ action: 'set', type: 'user', id: 'lenovo', label: 'human', value: '名字是哲。' })
  const seededAgent = await setViaCli({ action: 'set', type: 'agent', id: 'claude-code-memory', label: 'role', value: '名字是余。' })
  check('the CLI creates the store and writes a block',
    seeded.ok === true && seededAgent.ok === true,
    seeded.ok ? 'ok' : String(seeded.error).slice(0, 80))

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
    // The plugin's write route must reach the same throwaway store, so it
    // inherits pythonPath/projectDir/env from the extract config.
    extract: {
      enabled: true, everyNTurns: 3, statePath,
      pythonPath: DEFAULT_EXTRACT.pythonPath,
      projectDir: DEFAULT_EXTRACT.projectDir,
      env: cliConfig.env,
    },
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
  check('all three exact routes are registered',
    routes.has(STATUS_PATH) && routes.has(REFRESH_PATH) && routes.has(BLOCKS_PATH), [...routes.keys()].join(', '))

  const call = async (path, method = 'GET', body = null, headers = { host: '127.0.0.1:19387' }) => {
    const out = { code: null, body: null }
    const res = { writeHead(code) { out.code = code }, end(payload) { out.body = JSON.parse(payload) } }
    // A minimal readable stream, which is what `readJsonBody` consumes.
    const req = {
      headers, method,
      on(event, handler) {
        if (event === 'data' && body !== null) handler(typeof body === 'string' ? body : JSON.stringify(body))
        if (event === 'end') handler()
      },
    }
    await routes.get(path).handler(req, res)
    return out
  }

  const first = await call(STATUS_PATH)
  check('GET status returns ok with real blocks',
    first.code === 200 && first.body.ok === true && first.body.read.blockCount === 2,
    `blocks=${first.body.read.blockCount}`)
  check('the payload carries the blocks the prompt got',
    first.body.blocks.map((b) => `${b.scope}/${b.label}`).join(',') === 'user/lenovo/human,agent/claude-code-memory/role')
  check('each block carries its stored value_limit',
    first.body.blocks.every((b) => Number.isInteger(b.limit) && b.limit > 0),
    first.body.blocks.map((b) => b.limit).join(','))
  check('extraction state is reported, including persisted diagnostics',
    first.body.extract.sessions === 2 && first.body.extract.diagnostics[0].outcome === 'ok added=1'
    && first.body.extract.everyNTurns === 3,
    `sessions=${first.body.extract.sessions} diag=${first.body.extract.diagnostics.length}`)
  check('the read half reports its budget and TTL',
    first.body.read.maxChars === 4000 && first.body.read.refreshMs === 30000)
  check('the payload says the panel may write', first.body.writable === true)

  // A row written now must NOT appear while the render TTL is warm …
  const wrote = await setViaCli({ action: 'set', type: 'user', id: 'lenovo', label: 'persona', value: '协作风格：简练。' })
  check('the CLI upserts a block into the same store', wrote.ok === true, String(wrote.error ?? '').slice(0, 60))
  const warm = await call(STATUS_PATH)
  check('a warm TTL serves the cached render', warm.body.read.blockCount === 2, `blocks=${warm.body.read.blockCount}`)

  // … and POST /refresh must bypass it.
  const forced = await call(REFRESH_PATH, 'POST')
  check('POST refresh bypasses the TTL and picks the new block up',
    forced.body.read.blockCount === 3 && forced.body.blocks.some((b) => b.label === 'persona'),
    `blocks=${forced.body.read.blockCount}`)
  check('the refreshed text is what the prompt will inject next',
    contexts[0].text().includes('[user/lenovo/persona]'))

  // ── the write route, end to end ────────────────────────────────────────────
  const untrustedWrite = await call(BLOCKS_PATH, 'POST', { action: 'set' }, { host: 'evil.example' })
  check('the write route refuses an untrusted host', untrustedWrite.code === 403, `code=${untrustedWrite.code}`)

  const wrongVerb = await call(BLOCKS_PATH, 'GET')
  check('the write route is POST only', wrongVerb.code === 405, `code=${wrongVerb.code}`)

  const badAction = await call(BLOCKS_PATH, 'POST', { action: 'nuke', type: 'user', id: 'lenovo', label: 'x' })
  check('a bad action is a 400, not a write', badAction.code === 400 && /action must be/.test(badAction.body.error),
    badAction.body.error)

  const emptyValue = await call(BLOCKS_PATH, 'POST', { action: 'set', type: 'user', id: 'lenovo', label: 'empty', value: '   ' })
  check('an empty value is refused (the reader would skip it)',
    emptyValue.code === 400 && /value is required/.test(emptyValue.body.error), emptyValue.body.error)

  const notJson = await call(BLOCKS_PATH, 'POST', '{not json')
  check('an unparsable body is a 400', notJson.code === 400 && /not valid JSON/.test(notJson.body.error), notJson.body.error)

  const beforeWrite = await call(STATUS_PATH)
  const written = await call(BLOCKS_PATH, 'POST', {
    action: 'set', type: 'user', id: 'lenovo', label: 'panel-made', value: '由面板写入的块。',
  })
  check('the write route writes through the CLI',
    written.code === 200 && written.body.ok === true && written.body.action === 'set', JSON.stringify(written.body).slice(0, 90))

  const afterWrite = await call(STATUS_PATH)
  check('a write invalidates the render, so the very next status sees it',
    beforeWrite.body.read.blockCount === 3 && afterWrite.body.read.blockCount === 4
    && afterWrite.body.blocks.some((b) => b.label === 'panel-made'),
    `${beforeWrite.body.read.blockCount} -> ${afterWrite.body.read.blockCount}`)
  check('the prompt text carries the block the panel just wrote',
    contexts[0].text().includes('[user/lenovo/panel-made]'))

  const edited = await call(BLOCKS_PATH, 'POST', {
    action: 'set', type: 'user', id: 'lenovo', label: 'panel-made', value: '改过一次。',
  })
  const afterEdit = await call(STATUS_PATH)
  check('the same label is an upsert, not a second block',
    edited.code === 200 && afterEdit.body.read.blockCount === 4
    && afterEdit.body.blocks.find((b) => b.label === 'panel-made').value === '改过一次。',
    `blocks=${afterEdit.body.read.blockCount}`)

  const deleted = await call(BLOCKS_PATH, 'POST', {
    action: 'delete', type: 'user', id: 'lenovo', label: 'panel-made',
  })
  const afterDelete = await call(STATUS_PATH)
  check('the delete action removes the block',
    deleted.code === 200 && afterDelete.body.read.blockCount === 3
    && !afterDelete.body.blocks.some((b) => b.label === 'panel-made'),
    `blocks=${afterDelete.body.read.blockCount}`)

  const deleteWithValue = await call(BLOCKS_PATH, 'POST', {
    action: 'delete', type: 'user', id: 'lenovo', label: 'persona', value: 'x',
  })
  check('delete refuses a value', deleteWithValue.code === 400, deleteWithValue.body.error)

  // A read-only panel: the plugin keeps `writeBlock: null`, so the route 403s.
  const readOnlyChildren = []
  applyHost({ ...ctx, inject: (deps, cb) => readOnlyChildren.push({ deps, cb }) }, {
    dbPath, panel: { writes: false }, extract: { enabled: false, statePath },
  })
  const readOnlyRoutes = new Map()
  readOnlyChildren[0].cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { readOnlyRoutes.set(r.path, r); return () => {} } },
  })
  const readOnlyRes = { code: null, body: null }
  await readOnlyRoutes.get(BLOCKS_PATH).handler(
    { headers: { host: '127.0.0.1:19387' }, method: 'POST', on(event, handler) { if (event === 'end') handler() } },
    { writeHead(code) { readOnlyRes.code = code }, end(payload) { readOnlyRes.body = JSON.parse(payload) } },
  )
  check('panel.writes:false makes the write route answer 403',
    readOnlyRes.code === 403 && /disabled/.test(readOnlyRes.body.error), readOnlyRes.body.error)
  const readOnlyStatus = { code: null, body: null }
  await readOnlyRoutes.get(STATUS_PATH).handler(
    { headers: { host: '127.0.0.1:19387' }, method: 'GET' },
    { writeHead(code) { readOnlyStatus.code = code }, end(payload) { readOnlyStatus.body = JSON.parse(payload) } },
  )
  check('the status payload tells the panel it is read-only', readOnlyStatus.body.writable === false)

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
