/**
 * M2 acceptance: hybrid retrieval and the answerability guard.
 *
 * The hashing embedder is weak by design, so the vector assertions are about
 * channels joining the fusion, not about semantics; the guard assertions are the
 * behaviour that matters (a numeric question with no number must not come back
 * as an answer).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { LocalEmbedder, tokenize } from '../lib/core/embed.js'
import { searchMemories, answerabilityGuard } from '../lib/core/search.js'
import { RuleExtractor } from '../lib/core/extract.js'
import { remember } from '../lib/core/write.js'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-m2-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)

test('the local embedder is deterministic and measures overlap', () => {
  const embedder = new LocalEmbedder(384)
  const base = embedder.embedOne('用户在 SJS 项目里用 Postgres 存违规事件。')
  assert.deepEqual([...base], [...embedder.embedOne('用户在 SJS 项目里用 Postgres 存违规事件。')])
  const close = embedder.embedOne('用户在 SJS 项目里用 Postgres 记录违规事件。')
  const far = embedder.embedOne('用户偏好中文回答。')
  assert.ok(dot(base, close) > dot(base, far))
})

test('tokenize produces words, CJK chars and bigrams', () => {
  const tokens = tokenize('SJS 违规')
  assert.ok(tokens.includes('sjs'))
  assert.ok(tokens.includes('违'))
  assert.ok(tokens.includes('违规'))
})

test('keyword search finds a Chinese substring', (t) => {
  const store = openStore(t)
  const row = store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  store.addMemory({ userId: 'u1', text: '用户偏好中文回答。' })
  const out = searchMemories(store, '违规事件', { userId: 'u1' })
  assert.equal(out.results[0].id, row.id)
  assert.equal(out.results[0].keywordRank, 0)
})

test('two-character queries fall back to the LIKE scan', (t) => {
  const store = openStore(t)
  const row = store.addMemory({ userId: 'u1', text: 'SJS 服务的端口是 8780。' })
  const out = searchMemories(store, '端口', { userId: 'u1' })
  assert.equal(out.results[0].id, row.id)
})

test('vector scores join the fused ranking when vectors exist', (t) => {
  const store = openStore(t)
  const embedder = new LocalEmbedder(384)
  const row = store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  store.addMemory({ userId: 'u1', text: '用户偏好中文回答。' })
  for (const memory of store.currentMemories({ userId: 'u1' })) {
    store.saveEmbedding(memory.id, embedder.model, embedder.embedOne(memory.text))
  }
  const withVectors = searchMemories(store, '违规记录', { userId: 'u1', embedder })
  assert.equal(withVectors.results[0].id, row.id)
  assert.equal(withVectors.results[0].keywordRank, 0)
  assert.equal(withVectors.results[0].vectorRank, 0)

  // Without an embedder the vector channel is simply absent, not zero.
  const withoutVectors = searchMemories(store, '违规记录', { userId: 'u1' })
  assert.equal(withoutVectors.results[0].keywordRank, 0)
  assert.equal(withoutVectors.results[0].vectorRank, null)
})

test('the query guard rejects a numeric question with no number to answer from', (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  const out = searchMemories(store, '违规事件表有多少行', { userId: 'u1' })
  assert.equal(out.answerable, false)
  assert.match(out.note, /do not answer/)
  assert.equal(answerabilityGuard('违规事件表有多少行', ['用户在 SJS 项目里用 Postgres 存违规事件。']), 'reject')
  assert.equal(answerabilityGuard('周更几点跑', ['SJS 的周更链路每天 02:00 跑一次。']), 'unknown')
})

test('search returns only the current version and the requested scope', (t) => {
  const store = openStore(t)
  const old = store.addMemory({ userId: 'u1', text: '用户的编辑器是 VS Code。' })
  store.supersede(old.id, { text: '用户的编辑器是 Neovim。', actor: 'test' })
  store.addMemory({ userId: 'u2', text: '用户喜欢猫。' })

  const out = searchMemories(store, '编辑器', { userId: 'u1' })
  assert.deepEqual(out.results.map((row) => row.text), ['用户的编辑器是 Neovim。'])
})

test('remember stores vectors so the next search can use them', async (t) => {
  const store = openStore(t)
  const embedder = new LocalEmbedder(384)
  await remember({
    store,
    scope: { userId: 'u1' },
    messages: [{ role: 'user', content: '我喜欢吃辣。' }],
    extractor: new RuleExtractor(),
    embedder,
  })
  assert.equal(store.stats().embeddings, 1)
  const out = searchMemories(store, '吃辣', { userId: 'u1', embedder })
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].vectorRank, 0)
})
