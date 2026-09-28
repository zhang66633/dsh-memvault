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
import {
  BLOCKS_PATH,
  BLOCK_VALUE_CLAMP,
  FLAG_PATH,
  FLUSH_PATH,
  MAX_BODY_BYTES,
  MEMORIES_PATH,
  MEMORY_PATH,
  REFRESH_PATH,
  REPLAY_PATH,
  REVIEW_PATH,
  STATUS_PATH,
  buildStatus,
  createPanelApi,
  isTrustedRequest,
  readJsonBody,
} from '../lib/panel.js'
import {
  DEFAULT_LIMIT,
  MAX_IDS,
  MAX_LIMIT,
  MEMORY_TEXT_CLAMP,
  buildMemoryQuery,
  readMemories,
  readMemoryProvenance,
  shapeMemoryRow,
} from '../lib/memories.js'
import { MAX_FLAGS, NOTE_CLAMP, flaggedIds, normalizeFlags, setFlag } from '../lib/flags.js'
import {
  INPUT_TEXT_CLAMP,
  MAX_INPUTS,
  MAX_PRODUCED_INDEX,
  buildReviewRequest,
  pruneInputs,
  pruneProduced,
  recordProduced,
  shapeReviewItem,
  storeInput,
  validateReplay,
} from '../lib/review.js'
import { PRODUCED_TEXT_CLAMP, shapeProduced } from '../lib/extract.js'
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

// ── the browse query builder (pure) ─────────────────────────────────────────
{
  const plain = buildMemoryQuery({})
  check('a bare browse selects the display columns, newest first, and a page',
    plain.sql.startsWith('SELECT id, user_id, agent_id, run_id, memory, memory_type, metadata, created_at, updated_at FROM memories')
    && plain.sql.includes('ORDER BY created_at DESC')
    && plain.sql.endsWith('LIMIT ? OFFSET ?')
    && plain.limit === DEFAULT_LIMIT && plain.offset === 0,
    plain.sql)

  const searched = buildMemoryQuery({ q: "50%_x\\y'; DROP TABLE memories; --", type: 'user', user: 'lenovo', limit: '7', offset: '3' })
  check('every value is a placeholder, never interpolated',
    !searched.sql.includes('DROP') && !searched.sql.includes('lenovo')
    && searched.sql.includes("memory LIKE ? ESCAPE '\\'") && searched.sql.includes('memory_type = ?')
    && searched.sql.includes('user_id = ?'),
    searched.sql)
  check('LIKE wildcards in the query are escaped',
    searched.args[0] === "%50\\%\\_x\\\\y'; DROP TABLE memories; --%",
    String(searched.args[0]))
  check('limit and offset are parsed and appended after the filters',
    searched.limit === 7 && searched.offset === 3
    && searched.args.at(-2) === 7 && searched.args.at(-1) === 3,
    JSON.stringify(searched.args))
  check('the applied filters are echoed back',
    searched.applied.q.startsWith('50%') && searched.applied.type === 'user' && searched.applied.user === 'lenovo'
    && searched.applied.agent === null,
    JSON.stringify(searched.applied))

  const clamped = buildMemoryQuery({ limit: '9999', offset: '-5', order: 'nope' })
  check('limit is capped, a negative offset is ignored, an unknown order falls back',
    clamped.limit === MAX_LIMIT && clamped.offset === 0 && clamped.order === 'created'
    && clamped.sql.includes('ORDER BY created_at DESC'),
    `limit=${clamped.limit} offset=${clamped.offset} order=${clamped.order}`)
  check('the updated order sorts by updated_at',
    buildMemoryQuery({ order: 'updated' }).sql.includes('ORDER BY updated_at DESC, id DESC'))
  check('a count query shares the filters but not the page',
    buildMemoryQuery({ q: 'x', limit: 5 }).countSql === 'SELECT COUNT(*) AS n FROM memories WHERE memory LIKE ? ESCAPE \'\\\'',
    buildMemoryQuery({ q: 'x', limit: 5 }).countSql)

  check('a long memory is clamped for display but reports its length',
    shapeMemoryRow({ id: 'm1', memory: 'x'.repeat(MEMORY_TEXT_CLAMP + 50), memory_type: 'user' }).chars === MEMORY_TEXT_CLAMP + 50
    && shapeMemoryRow({ id: 'm1', memory: 'x'.repeat(MEMORY_TEXT_CLAMP + 50) }).memory.length === MEMORY_TEXT_CLAMP + 1)
  check('broken metadata does not break the row',
    shapeMemoryRow({ id: 'm', memory: 'a', metadata: '{not json' }).metadata === null)

  const byIds = buildMemoryQuery({ ids: ' a , b ,, c ' })
  check('an id list becomes placeholders, capped',
    byIds.sql.includes('id IN (?, ?, ?)')
    && byIds.args.slice(0, 3).join(',') === 'a,b,c'
    && byIds.applied.ids.join(',') === 'a,b,c',
    byIds.sql)
  check('an empty id list adds no clause',
    !buildMemoryQuery({ ids: ' , ' }).sql.includes('IN (')
    && buildMemoryQuery({ ids: ',' }).applied.ids.length === 0)
  check('the id list is capped', buildMemoryQuery({ ids: Array.from({ length: MAX_IDS + 20 }, (_, i) => `x${i}`).join(',') }).applied.ids.length === MAX_IDS)
}

// ── review flags (plugin state, never the store) ────────────────────────────
{
  check('a missing map normalises to an empty one',
    Object.keys(normalizeFlags(undefined)).length === 0 && Object.keys(normalizeFlags([])).length === 0
    && Object.keys(normalizeFlags({ a: 'nope' })).length === 0,
    JSON.stringify(normalizeFlags({ a: 'nope', b: { at: '2026-01-01' } })))

  const marked = setFlag({}, 'mem_1', true, { note: 'x'.repeat(NOTE_CLAMP + 50), at: '2026-01-02T00:00:00.000Z' })
  check('marking stores a clamped note and the timestamp',
    marked.mem_1.at === '2026-01-02T00:00:00.000Z' && marked.mem_1.note.length === NOTE_CLAMP,
    JSON.stringify({ at: marked.mem_1.at, note: marked.mem_1.note.length }))
  check('marking does not mutate the input', Object.keys({}).length === 0)

  const cleared = setFlag(marked, 'mem_1', false)
  check('clearing removes the mark', Object.keys(cleared).length === 0)
  check('an empty id is ignored', Object.keys(setFlag(marked, '', true)).length === 1)
  check('flaggedIds lists what is marked', flaggedIds(marked).join(',') === 'mem_1')

  const many = Array.from({ length: MAX_FLAGS + 10 }, (_, i) => [`m${i}`, { at: new Date(2026, 0, 1, 0, 0, i).toISOString() }])
  const capped = normalizeFlags(Object.fromEntries(many))
  check('the flag map keeps the newest and stays bounded',
    Object.keys(capped).length === MAX_FLAGS && !Object.hasOwn(capped, 'm0')
    && Object.hasOwn(capped, `m${MAX_FLAGS + 9}`),
    `${Object.keys(capped).length} flags`)
}

// ── the review loop's state (retained inputs, reverse index, replay rules) ──
{
  const many = {}
  for (let i = 0; i < MAX_INPUTS + 3; i += 1) {
    many[`k${i}`] = { at: new Date(2026, 0, 1, 0, 0, i).toISOString(), text: `turn ${i}` }
  }
  const pruned = pruneInputs(many)
  check('retained inputs are bounded, newest first',
    Object.keys(pruned).length === MAX_INPUTS && !Object.hasOwn(pruned, 'k0')
    && Object.hasOwn(pruned, `k${MAX_INPUTS + 2}`),
    Object.keys(pruned).join(','))
  check('malformed retained inputs are dropped',
    Object.keys(pruneInputs({ a: null, b: 'x', c: [], d: { text: '' }, e: { text: 'ok' } })).join(',') === 'e',
    Object.keys(pruneInputs({ a: null, b: 'x', c: [], d: { text: '' }, e: { text: 'ok' } })).join(','))

  const before = { k: { text: 'kept' } }
  const stored = storeInput(before, 'new', { text: 'x'.repeat(INPUT_TEXT_CLAMP + 10), seq: 7, sessionId: 's', turns: 2 })
  check('storing an input clamps the text and keeps the metadata',
    stored.new.text.length === INPUT_TEXT_CLAMP && stored.new.seq === 7 && stored.new.turns === 2
    && Object.hasOwn(stored, 'k') && !Object.hasOwn(before, 'new'),
    `${stored.new.chars} chars`)
  check('an empty key stores nothing', !Object.hasOwn(storeInput({}, '', { text: 'x' }), ''))

  const produced = recordProduced({}, [{ id: 'a' }, { id: null }, { id: 'b' }], { seq: 3, sessionId: 's', inputKey: 's@3' })
  check('the produced index keeps ids and drops the rest',
    Object.keys(produced).join(',') === 'a,b' && produced.a.seq === 3 && produced.a.inputKey === 's@3',
    JSON.stringify(produced))
  const replayed = recordProduced(produced, [{ id: 'c' }], { seq: null, replayOf: 's@3', inputKey: 's@3' })
  check('a replay records itself as such',
    replayed.c.replayOf === 's@3' && Object.keys(replayed).length === 3)
  const bigIndex = Object.fromEntries(Array.from({ length: MAX_PRODUCED_INDEX + 5 }, (_, i) =>
    [`m${i}`, { at: new Date(2026, 0, 1, 0, 0, i).toISOString() }]))
  check('the produced index is bounded, newest kept',
    Object.keys(pruneProduced(bigIndex)).length === MAX_PRODUCED_INDEX
    && !Object.hasOwn(pruneProduced(bigIndex), 'm0'))

  const inputs = { k1: { at: '2026-01-02T00:00:00.000Z', seq: 9, turns: 2, text: '用户: 我喜欢吃辣。' } }
  const valid = validateReplay({ key: 'k1' }, { inputs, minTranscriptChars: 5 })
  check('a replay defaults to the stored text and inherits the extractor',
    valid.ok === true && valid.text === inputs.k1.text && valid.extractor === 'inherit'
    && Object.keys(valid.env).length === 0,
    JSON.stringify({ extractor: valid.extractor, env: valid.env }))
  check('an explicit extractor becomes an environment override',
    validateReplay({ key: 'k1', extractor: 'rule' }, { inputs }).env.MEMVAULT_EXTRACTOR === 'rule'
    && validateReplay({ key: 'k1', extractor: 'llm' }, { inputs }).env.MEMVAULT_EXTRACTOR === 'llm')
  check('edited text is used as given',
    validateReplay({ key: 'k1', text: '改过的输入' }, { inputs }).text === '改过的输入')
  check('an unknown key is a 404',
    validateReplay({ key: 'nope' }, { inputs }).status === 404
    && validateReplay({}, { inputs }).status === 404)
  check('a bad extractor is a 400',
    validateReplay({ key: 'k1', extractor: 'magic' }, { inputs }).status === 400)
  check('text over the clamp is a 400',
    validateReplay({ key: 'k1', text: 'x'.repeat(INPUT_TEXT_CLAMP + 1) }, { inputs }).status === 400)
  check('text below the plugin’s own floor is a 400',
    validateReplay({ key: 'k1', text: '  a  ' }, { inputs, minTranscriptChars: 10 }).status === 400)

  const item = shapeReviewItem({
    row: { id: 'm1', memory: '文本', chars: 2 },
    flag: { at: '2026-01-02T00:00:00.000Z', note: '助手口吻' },
    window: { seq: 9, at: '2026-01-02T00:00:00.000Z', inputKey: 'k1' },
    provenance: { history: [{ action: 'ADD' }], relations: [] },
    replayable: true,
  })
  check('a review item carries its flag, window, provenance and replayability',
    item.flaggedAt === '2026-01-02T00:00:00.000Z' && item.note === '助手口吻'
    && item.window.seq === 9 && item.replayable === true && item.history[0].action === 'ADD',
    JSON.stringify(item.window))
  check('a review item without a window says so',
    shapeReviewItem({ row: { id: 'm2' } }).window === null
    && shapeReviewItem({ row: { id: 'm2' } }).replayable === false)
  const request = buildReviewRequest([item])
  check('the model-facing request carries the id, the text and the provenance',
    request.includes('m1') && request.includes('文本') && request.includes('助手口吻')
    && request.includes('窗口 @9') && request.includes('审计') && request.includes('不要执行任何写操作'),
    request.split('\n')[0])
  check('an empty queue builds no request', buildReviewRequest([]) === '')
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
  check('all nine exact routes are registered',
    routes.has(STATUS_PATH) && routes.has(REFRESH_PATH) && routes.has(BLOCKS_PATH)
    && routes.has(FLUSH_PATH) && routes.has(MEMORIES_PATH) && routes.has(MEMORY_PATH)
    && routes.has(FLAG_PATH) && routes.has(REVIEW_PATH) && routes.has(REPLAY_PATH),
    [...routes.keys()].join(', '))

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
  check('a clean config reports no issues',
    first.body.configIssues.unknown.length === 0 && first.body.configIssues.problems.length === 0,
    JSON.stringify(first.body.configIssues))
  check('the payload reports the window policy and an empty window',
    first.body.extract.window.everyNTurns === 3 && first.body.extract.window.idleMs === 20000
    && first.body.extract.window.windowTurns === 8 && Array.isArray(first.body.extract.window.pending)
    && first.body.extract.window.pending.length === 0,
    JSON.stringify(first.body.extract.window))

  // ── the flush route ────────────────────────────────────────────────────────
  const untrustedFlush = await call(FLUSH_PATH, 'POST', null, { host: 'evil.example' })
  check('the flush route refuses an untrusted host', untrustedFlush.code === 403, `code=${untrustedFlush.code}`)
  const flushVerb = await call(FLUSH_PATH, 'GET')
  check('the flush route is POST only', flushVerb.code === 405, `code=${flushVerb.code}`)
  const flushedEmpty = await call(FLUSH_PATH, 'POST')
  check('flushing an empty window is a reported no-op',
    flushedEmpty.code === 200 && flushedEmpty.body.flushed === 0, JSON.stringify(flushedEmpty.body))

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
  const readOnlyFlush = { code: null, body: null }
  await readOnlyRoutes.get(FLUSH_PATH).handler(
    { headers: { host: '127.0.0.1:19387' }, method: 'POST' },
    { writeHead(code) { readOnlyFlush.code = code }, end(payload) { readOnlyFlush.body = JSON.parse(payload) } },
  )
  check('with extraction disabled the flush route says so',
    readOnlyFlush.code === 405 && /disabled/.test(readOnlyFlush.body.error), readOnlyFlush.body.error)
  check('with extraction disabled the window is still reported (empty)',
    Array.isArray(readOnlyStatus.body.extract.window.pending)
    && readOnlyStatus.body.extract.window.pending.length === 0)

  // A config with a typo and a bad value: the plugin keeps running on defaults,
  // and the panel is what makes the mistake visible.
  const issueChildren = []
  applyHost({ ...ctx, inject: (deps, cb) => issueChildren.push({ deps, cb }) }, {
    dbPath,
    maxChars: 'not-a-number',
    nope: 1,
    extract: { enabled: false, statePath, wat: 2 },
  })
  const issueRoutes = new Map()
  issueChildren[0].cb({
    effect: (fn) => fn(),
    webServer: { register: (r) => { issueRoutes.set(r.path, r); return () => {} } },
  })
  const issueStatus = { code: null, body: null }
  await issueRoutes.get(STATUS_PATH).handler(
    { headers: { host: '127.0.0.1:19387' }, method: 'GET' },
    { writeHead(code) { issueStatus.code = code }, end(payload) { issueStatus.body = JSON.parse(payload) } },
  )
  check('an unknown key is reported to the panel',
    issueStatus.body.configIssues.unknown.includes('nope')
    && issueStatus.body.configIssues.unknown.includes('extract.wat'),
    JSON.stringify(issueStatus.body.configIssues.unknown))
  check('a wrong-typed value is reported and the default survives',
    issueStatus.body.configIssues.problems.some((p) => p.startsWith('maxChars'))
    && issueStatus.body.read.maxChars === 4000,
    JSON.stringify({ problems: issueStatus.body.configIssues.problems, maxChars: issueStatus.body.read.maxChars }))

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

  // ── the window, end to end: two turns, ONE extraction call ─────────────────
  {
    const windowDb = join(dir, 'window.db')
    const windowState = join(dir, 'window-state.json')
    const listeners = new Map()
    const windowChildren = []
    const windowCtx = {
      logger: { warn() {}, info() {} },
      effect: (fn) => fn(),
      on(name, fn) { listeners.set(name, fn) },
      systemPrompt: { context: () => () => {} },
      inject: (deps, cb) => windowChildren.push({ deps, cb }),
    }
    applyHost(windowCtx, {
      dbPath: windowDb,
      scopes: [{ type: 'user', id: 'lenovo' }],
      extract: {
        enabled: true,
        everyNTurns: 2,
        // Long enough that only the manual flush can trigger this run; the idle
        // path is covered by the fake-clock tests in smoke-extract.
        idleMs: 3_600_000,
        windowTurns: 8,
        minTranscriptChars: 10,
        statePath: windowState,
        pythonPath: DEFAULT_EXTRACT.pythonPath,
        projectDir: DEFAULT_EXTRACT.projectDir,
        env: {
          ...DEFAULT_EXTRACT.env,
          MEMVAULT_DB_PATH: windowDb,
          MEMVAULT_EMBEDDER: 'local',
          MEMVAULT_EXTRACTOR: 'rule',
        },
        user: 'lenovo',
        agent: null,
      },
    })
    const windowRoutes = new Map()
    windowChildren[0].cb({
      effect: (fn) => fn(),
      webServer: { register: (route) => { windowRoutes.set(route.path, route); return () => {} } },
    })
    const onEvent = listeners.get('session/event')
    check('the plugin subscribes to session/event', typeof onEvent === 'function')

    const session = { id: 'sess-window' }
    const feed = (seq, text) => {
      onEvent(session, { seq, type: 'user/message', data: { content: [{ type: 'text', text }] } })
      onEvent(session, { seq: seq + 1, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }
    const ask = async (path, method = 'GET') => {
      const out = { code: null, body: null }
      await windowRoutes.get(path).handler(
        { headers: { host: '127.0.0.1:19387' }, method, on(event, handler) { if (event === 'end') handler() } },
        { writeHead(code) { out.code = code }, end(payload) { out.body = JSON.parse(payload) } },
      )
      return out
    }

    feed(1, '我喜欢吃辣的食物，尤其是川菜。')
    feed(3, '我住在南京，周末常去爬山。')

    const waiting = await ask(STATUS_PATH)
    check('two finished turns wait in the window',
      waiting.body.extract.window.pending.length === 1
      && waiting.body.extract.window.pending[0].turns === 2
      && waiting.body.extract.window.pending[0].sessionId === 'sess-window',
      JSON.stringify(waiting.body.extract.window.pending))
    check('the waiting window is persisted for a restart',
      loadState(windowState).pending['sess-window']?.turns === 2,
      JSON.stringify(loadState(windowState).pending))
    check('the persisted window carries the rendered transcript',
      loadState(windowState).pending['sess-window']?.text.includes('南京'),
      String(loadState(windowState).pending['sess-window']?.chars))

    const flushed = await ask(FLUSH_PATH, 'POST')
    check('the flush route hands the window over', flushed.code === 200 && flushed.body.flushed === 1,
      JSON.stringify(flushed.body))

    const deadline = Date.now() + 90_000
    let diagnostic = null
    while (Date.now() < deadline) {
      const last = loadState(windowState).diagnostics.at(-1)
      if (last && Number(last.turns) === 2 && last.outcome !== undefined) { diagnostic = last; break }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    check('the window was extracted as ONE call covering both turns',
      diagnostic !== null && String(diagnostic.outcome).startsWith('ok'),
      JSON.stringify(diagnostic))
    check('the window is cleared and the watermark advanced past both turns',
      Object.keys(loadState(windowState).pending).length === 0
      && loadState(windowState).watermarks.get('sess-window') === 4,
      JSON.stringify({ pending: Object.keys(loadState(windowState).pending), wm: loadState(windowState).watermarks.get('sess-window') }))

    const windowStore = new DatabaseSync(windowDb, { readOnly: true })
    const rows = windowStore.prepare('SELECT memory FROM memories').all()
    windowStore.close()
    check('the extracted facts are in the store',
      rows.length >= 1 && rows.some((r) => typeof r.memory === 'string'),
      JSON.stringify(rows.map((r) => r.memory)))

    // ── the browse route, against the store extraction just wrote ────────────
    const hit = async (path, { method = 'GET', url = path, headers = { host: '127.0.0.1:19387' }, body = null } = {}) => {
      const out = { code: null, body: null }
      await windowRoutes.get(path).handler(
        {
          headers, method, url,
          on(event, handler) {
            if (event === 'data' && body !== null) handler(JSON.stringify(body))
            if (event === 'end') handler()
          },
        },
        { writeHead(code) { out.code = code }, end(payload) { out.body = JSON.parse(payload) } },
      )
      return out
    }
    const browse = (url = MEMORIES_PATH, method = 'GET', headers = null) =>
      hit(MEMORIES_PATH, { url, method, ...(headers ? { headers } : {}) })
    const page = await browse()
    check('the browse route returns the stored memories',
      page.code === 200 && page.body.ok === true && page.body.total === 2 && page.body.rows.length === 2,
      `total=${page.body.total} rows=${page.body.rows.length}`)
    check('the payload never carries the embedding blob',
      !JSON.stringify(page.body).includes('embedding')
      && Object.keys(page.body.rows[0]).sort().join(',')
        === 'agent,chars,createdAt,id,memory,metadata,run,type,updatedAt,user',
      Object.keys(page.body.rows[0]).join(','))
    check('the payload says this is a substring browse, not retrieval', page.body.mode === 'substring')

    const substringHit = await browse(`${MEMORIES_PATH}?q=${encodeURIComponent('南京')}`)
    check('a substring search finds the row extraction produced',
      substringHit.body.total === 1 && substringHit.body.rows[0].memory.includes('南京'), JSON.stringify(substringHit.body.applied))

    const literal = await browse(`${MEMORIES_PATH}?q=${encodeURIComponent('%')}`)
    check('a literal % is a literal, not a wildcard', literal.body.total === 0, `total=${literal.body.total}`)

    const typed = await browse(`${MEMORIES_PATH}?type=user`)
    const bogus = await browse(`${MEMORIES_PATH}?type=bogus`)
    check('the type filter applies and is echoed',
      typed.body.total === 2 && typed.body.applied.type === 'user'
      && bogus.body.total === 0 && bogus.body.applied.type === 'bogus',
      `${typed.body.total} / ${bogus.body.total}`)

    const firstPage = await browse(`${MEMORIES_PATH}?limit=1`)
    const secondPage = await browse(`${MEMORIES_PATH}?limit=1&offset=1`)
    check('paging walks the store without repeating a row',
      firstPage.body.rows.length === 1 && secondPage.body.rows.length === 1
      && firstPage.body.total === 2 && secondPage.body.total === 2
      && firstPage.body.rows[0].id !== secondPage.body.rows[0].id,
      `${firstPage.body.rows[0].id} vs ${secondPage.body.rows[0].id}`)
    check('the page size is capped',
      (await browse(`${MEMORIES_PATH}?limit=9999`)).body.limit === MAX_LIMIT)

    const injection = await browse(`${MEMORIES_PATH}?q=${encodeURIComponent("'; DROP TABLE memories; --")}`)
    const after = await browse()
    check('an injection-shaped query is just a query',
      injection.code === 200 && injection.body.total === 0 && after.body.total === 2,
      `total after=${after.body.total}`)

    check('the browse route is GET only', (await browse(MEMORIES_PATH, 'POST')).code === 405)
    check('the browse route refuses an untrusted host',
      (await browse(MEMORIES_PATH, 'GET', { host: 'evil.example' })).code === 403)

    const direct = readMemories({ dbPath: windowDb, query: { q: '南京' } })
    check('the reader is usable outside the route too',
      direct.rows.length === 1 && direct.limit === DEFAULT_LIMIT, `rows=${direct.rows.length}`)

    // ── provenance: how a memory became what it is ──────────────────────────
    const target = page.body.rows[0]
    const detail = await (async () => {
      const out = { code: null, body: null }
      await windowRoutes.get(MEMORY_PATH).handler(
        { headers: { host: '127.0.0.1:19387' }, method: 'GET', url: `${MEMORY_PATH}?id=${encodeURIComponent(target.id)}` },
        { writeHead(code) { out.code = code }, end(payload) { out.body = JSON.parse(payload) } },
      )
      return out
    })()
    check('provenance answers with the row and its audit trail',
      detail.code === 200 && detail.body.ok === true && detail.body.memory.id === target.id
      && Array.isArray(detail.body.history) && Array.isArray(detail.body.relations)
      && detail.body.history.length >= 1 && detail.body.history[0].action !== undefined,
      JSON.stringify(detail.body.history.map((h) => h.action)))
    check('provenance never carries the embedding blob', !JSON.stringify(detail.body).includes('embedding'))

    const unknown = await (async () => {
      const out = { code: null, body: null }
      await windowRoutes.get(MEMORY_PATH).handler(
        { headers: { host: '127.0.0.1:19387' }, method: 'GET', url: `${MEMORY_PATH}?id=nope` },
        { writeHead(code) { out.code = code }, end(payload) { out.body = JSON.parse(payload) } },
      )
      return out
    })()
    check('an unknown id is a 404, not a 500',
      unknown.code === 404 && unknown.body.ok === false && unknown.body.missing === true, `code=${unknown.code}`)

    // ── review flags: plugin state, never the store ─────────────────────────
    const flagCall = async (payload, method = 'POST', headers = { host: '127.0.0.1:19387' }) => {
      const out = { code: null, body: null }
      await windowRoutes.get(FLAG_PATH).handler(
        {
          headers, method,
          on(event, handler) {
            if (event === 'data' && payload !== null) handler(JSON.stringify(payload))
            if (event === 'end') handler()
          },
        },
        { writeHead(code) { out.code = code }, end(body) { out.body = JSON.parse(body) } },
      )
      return out
    }

    const flagged = await flagCall({ id: target.id, flagged: true, note: '看起来是助手口吻' })
    check('flagging answers with the whole bounded map',
      flagged.code === 200 && flagged.body.flaggedCount === 1 && Object.hasOwn(flagged.body.flags, target.id)
      && flagged.body.persisted === true,
      JSON.stringify(flagged.body))
    check('the flag lands in the plugin state file, not the store',
      Object.hasOwn(loadState(windowState).flags, target.id)
      && !JSON.stringify(readMemories({ dbPath: windowDb, query: {} })).includes('看起来是助手口吻'))

    const onlyFlagged = await browse(`${MEMORIES_PATH}?flagged=1`)
    check('the flagged filter returns exactly the marked rows',
      onlyFlagged.body.total === 1 && onlyFlagged.body.rows[0].id === target.id
      && onlyFlagged.body.flaggedCount === 1,
      `total=${onlyFlagged.body.total}`)
    check('the flag travels with every browse payload',
      Object.hasOwn((await browse()).body.flags, target.id))

    const unflagged = await flagCall({ id: target.id, flagged: false })
    check('unflagging empties the filter',
      unflagged.body.flaggedCount === 0 && (await browse(`${MEMORIES_PATH}?flagged=1`)).body.total === 0)

    check('a bad flag body is a 400',
      (await flagCall({ id: target.id })).code === 400 && (await flagCall({ flagged: true })).code === 400)
    check('the flag route is POST only', (await flagCall(null, 'GET')).code === 405)
    check('the flag route refuses an untrusted host',
      (await flagCall({ id: target.id, flagged: true }, 'POST', { host: 'evil.example' })).code === 403)

    // ── a window's diagnostic links back to what it produced ────────────────
    const withProduced = loadState(windowState).diagnostics.filter((d) => Array.isArray(d.produced) && d.produced.length > 0)
    check('the extraction diagnostic records the ids it produced',
      withProduced.length === 1 && withProduced[0].produced.length === 2
      && withProduced[0].produced.every((p) => typeof p.id === 'string' && p.text.length <= PRODUCED_TEXT_CLAMP + 1),
      JSON.stringify(withProduced[0]?.produced?.map((p) => p.id)))
    const producedIds = withProduced[0].produced.map((p) => p.id).join(',')
    const fromDiagnostic = await browse(`${MEMORIES_PATH}?ids=${encodeURIComponent(producedIds)}`)
    check('browsing by those ids returns exactly the window’s output',
      fromDiagnostic.body.total === 2 && fromDiagnostic.body.rows.every((r) => producedIds.includes(r.id)),
      `total=${fromDiagnostic.body.total}`)
    check('a shaped production line is clamped and id-less rows are dropped',
      shapeProduced([
        { id: 'a', memory: 'x'.repeat(PRODUCED_TEXT_CLAMP + 5), memory_type: 'user' },
        { id: null, memory: 'no id' },
        { id: 'b', memory: 'ok' },
      ]).length === 2)

    // ── the review queue, and a real replay ─────────────────────────────────
    const stateNow = loadState(windowState)
    check('the state file retains what the window sent',
      Object.keys(stateNow.inputs).length === 1
      && Object.values(stateNow.inputs)[0].text.includes('南京')
      && Object.values(stateNow.inputs)[0].turns === 2,
      JSON.stringify(Object.values(stateNow.inputs).map((i) => i.chars)))
    const inputKey = Object.keys(stateNow.inputs)[0]
    check('the reverse index links each produced memory to its window',
      Object.keys(stateNow.produced).length === 2
      && Object.values(stateNow.produced).every((entry) => entry.inputKey === inputKey && entry.seq === 4),
      JSON.stringify(Object.values(stateNow.produced)[0]))
    check('the browse payload carries the reverse index',
      Object.hasOwn((await browse()).body.produced, target.id))

    const emptyQueue = await hit(REVIEW_PATH)
    check('an empty queue has no items and no request',
      emptyQueue.code === 200 && emptyQueue.body.items.length === 0 && emptyQueue.body.request === '',
      JSON.stringify(emptyQueue.body))

    await flagCall({ id: target.id, flagged: true, note: '看着像助手口吻' })
    const queue = await hit(REVIEW_PATH)
    check('the queue resolves the flagged row with its provenance and window',
      queue.body.items.length === 1 && queue.body.items[0].id === target.id
      && queue.body.items[0].note === '看着像助手口吻'
      && queue.body.items[0].window?.seq === 4
      && queue.body.items[0].replayable === true
      && queue.body.items[0].history.length >= 1
      && typeof queue.body.items[0].inputText === 'string',
      JSON.stringify(queue.body.items[0].window))
    check('the queue hands over a model-ready request',
      queue.body.request.includes(target.id) && queue.body.request.includes('待复核')
      && queue.body.request.includes('不要执行任何写操作'),
      queue.body.request.split('\n')[0])

    const replayBadKey = await hit(REPLAY_PATH, { method: 'POST', body: { key: 'nope' } })
    check('replaying an unknown input is a 404', replayBadKey.code === 404, `code=${replayBadKey.code}`)
    const replayBadExtractor = await hit(REPLAY_PATH, { method: 'POST', body: { key: inputKey, extractor: 'magic' } })
    check('an unknown extractor is a 400', replayBadExtractor.code === 400, `code=${replayBadExtractor.code}`)
    check('the replay route is POST only', (await hit(REPLAY_PATH)).code === 405)
    check('the replay route refuses an untrusted host',
      (await hit(REPLAY_PATH, {
        method: 'POST', body: { key: inputKey }, headers: { host: 'evil.example' },
      })).code === 403)

    // The real thing: the retained input, sent through MemVault's own pipeline.
    const replay = await hit(REPLAY_PATH, { method: 'POST', body: { key: inputKey, extractor: 'rule' } })
    check('a replay is accepted and queued',
      replay.code === 202 && replay.body.ok === true && replay.body.key === inputKey
      && replay.body.extractor === 'rule' && replay.body.queued === true,
      JSON.stringify(replay.body))

    const replayDeadline = Date.now() + 90_000
    let replayDiag = null
    while (Date.now() < replayDeadline) {
      replayDiag = loadState(windowState).diagnostics.findLast?.((d) => d.replayOf === inputKey) ?? null
      if (replayDiag) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    check('the replay records itself as a replay and reports its outcome',
      replayDiag !== null && String(replayDiag.outcome).startsWith('ok'),
      JSON.stringify(replayDiag))
    check('a replay does not overwrite the retained input',
      Object.hasOwn(loadState(windowState).inputs, inputKey) && Object.keys(loadState(windowState).inputs).length === 1)
    const storeAfter = new DatabaseSync(windowDb, { readOnly: true })
    const rowsAfter = storeAfter.prepare('SELECT COUNT(*) AS n FROM memories').get().n
    storeAfter.close()
    check('the replay went through the store (parsed, not raw)', rowsAfter >= 2, `rows=${rowsAfter}`)

    // ① A in practice: the same text re-sent goes through MemVault's own decision,
    // which recognises it as the same facts and updates in place — no duplicates.
    const originalIds = withProduced[0].produced.map((p) => p.id).sort()
    const replayIds = (replayDiag?.produced ?? []).map((p) => p.id).sort()
    check('replaying the same text updates the same rows instead of duplicating them',
      replayIds.join(',') === originalIds.join(',') && rowsAfter === originalIds.length,
      `original=${originalIds.join(',')} replay=${replayIds.join(',')} rows=${rowsAfter}`)

    // A read-only panel cannot replay: it writes the store.
    const noReplayChildren = []
    applyHost({ ...ctx, inject: (deps, cb) => noReplayChildren.push({ deps, cb }) }, {
      dbPath: windowDb, panel: { writes: false }, extract: { enabled: false, statePath: windowState },
    })
    const noReplayRoutes = new Map()
    noReplayChildren[0].cb({
      effect: (fn) => fn(),
      webServer: { register: (r) => { noReplayRoutes.set(r.path, r); return () => {} } },
    })
    const noReplay = { code: null, body: null }
    await noReplayRoutes.get(REPLAY_PATH).handler(
      { headers: { host: '127.0.0.1:19387' }, method: 'POST', on(event, handler) { if (event === 'end') handler() } },
      { writeHead(code) { noReplay.code = code }, end(payload) { noReplay.body = JSON.parse(payload) } },
    )
    check('panel.writes:false disables replay (it writes the store)',
      noReplay.code === 403 && /disabled/.test(noReplay.body.error), noReplay.body.error)
  }
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
