/**
 * The LLM answerability adjudicator and its place in retrieval.
 *
 * What matters here is not the model call but the policy around it: it is only
 * paid for in the ambiguous band, the guard's rejection wins without asking, and
 * every failure leaves the earlier verdict (usually "unknown") untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { LocalEmbedder } from '../lib/core/embed.js'
import { searchMemories } from '../lib/core/search.js'
import { LLMAdjudicator, parseVerdict, resolveAdjudicator } from '../lib/core/adjudicate.js'
import { buildMemoryTools } from '../lib/core/tools.js'

const MEMORY = '用户用 VS Code 作为编辑器，主题是暗色。'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-adjudicate-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const fakeAdjudicator = (verdict) => ({
  calls: 0,
  async check() {
    this.calls += 1
    return verdict
  },
})

test('parseVerdict reads the JSON object and tolerates fences', () => {
  assert.deepEqual(parseVerdict('{"answerable": false, "reason": "只是提到"}'),
    { answerable: false, reason: '只是提到' })
  assert.deepEqual(parseVerdict('```json\n{"answerable": true}\n```'),
    { answerable: true, reason: null })
  assert.equal(parseVerdict('没有可回答的'), null)
  assert.equal(parseVerdict('{"answerable": "yes"}'), null)
})

test('the adjudicator never throws and reports a failed check as unknown', async () => {
  const yes = new LLMAdjudicator({ complete: async () => '{"answerable": true, "reason": "有事实"}' })
  assert.deepEqual(await yes.check('q', [{ text: 'x' }]), { answerable: true, reason: '有事实' })

  const broken = new LLMAdjudicator({ complete: async () => { throw new Error('timeout') } })
  const failed = await broken.check('q', [{ text: 'x' }])
  assert.equal(failed.answerable, null)
  assert.match(failed.reason, /timeout/)

  const garbage = new LLMAdjudicator({ complete: async () => '不知道' })
  assert.equal((await garbage.check('q', [{ text: 'x' }])).answerable, null)
})

test('an ambiguous search asks the model, and a "no" empties the result', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: MEMORY })
  const adjudicator = fakeAdjudicator({ answerable: false, reason: '只是提到编辑器' })

  const out = await searchMemories(store, '用户喜欢什么编辑器', { userId: 'u1', adjudicator })
  assert.equal(adjudicator.calls, 1)
  assert.equal(out.answerable, false)
  assert.deepEqual(out.results, [])
  assert.equal(out.note, '只是提到编辑器')
})

test('a failing adjudicator leaves the results and the unknown verdict alone', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: MEMORY })
  const adjudicator = fakeAdjudicator({ answerable: null, reason: 'adjudicator failed: timeout' })

  const out = await searchMemories(store, '用户喜欢什么编辑器', { userId: 'u1', adjudicator })
  assert.equal(out.answerable, null)
  assert.equal(out.results.length, 1)
  assert.match(out.note, /timeout/)
})

test('the numeric guard decides without asking the model', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: MEMORY })
  const adjudicator = fakeAdjudicator({ answerable: true, reason: '不该被问' })

  const out = await searchMemories(store, '用户用编辑器有多少个', { userId: 'u1', adjudicator })
  assert.equal(out.answerable, false)
  assert.equal(adjudicator.calls, 0)
})

test('two channels agreeing is the strong case: no model call', async (t) => {
  const store = openStore(t)
  const embedder = new LocalEmbedder(384)
  const memory = store.addMemory({ userId: 'u1', text: MEMORY })
  store.saveEmbedding(memory.id, embedder.model, await embedder.embedOne(MEMORY))
  const adjudicator = fakeAdjudicator({ answerable: false, reason: '不该被问' })

  const out = await searchMemories(store, MEMORY, { userId: 'u1', embedder, adjudicator })
  assert.ok(out.best >= 0.03, `best=${out.best}`)
  assert.equal(out.lowConfidence, false)
  assert.equal(adjudicator.calls, 0)
})

test('the memory_search tool reports the adjudicated verdict', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: MEMORY })
  const adjudicator = fakeAdjudicator({ answerable: false, reason: '只是提到编辑器' })
  const [search] = buildMemoryTools(store, { adjudicator })
  const out = await search.execute({ query: '用户喜欢什么编辑器', user_id: 'u1' })
  assert.equal(out.answerable, false)
  assert.deepEqual(out.results, [])
  assert.equal(out.note, '只是提到编辑器')
})

test('resolveAdjudicator needs a key and can be switched off', () => {
  assert.equal(resolveAdjudicator({ env: {} }), null)
  assert.equal(resolveAdjudicator({ env: { OPENAI_API_KEY: 'sk-x', MEMVAULT_ADJUDICATOR: 'off' } }), null)
  assert.ok(resolveAdjudicator({ env: { OPENAI_API_KEY: 'sk-x' } }) instanceof LLMAdjudicator)
})
