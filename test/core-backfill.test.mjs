/**
 * Embedder selection, the OpenAI client, and the backfill loop.
 *
 * These tests never touch the network: the OpenAI client takes `fetchImpl`, and
 * the backfill runs against a fake embedder. What is asserted is the behaviour
 * the migration depends on — the `.env` precedence the Python engine used, batch
 * ordering, and resumability (a second run embeds nothing).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { LocalEmbedder, OpenAIEmbedder } from '../lib/core/embed.js'
import { findEnvFile, readEnvFile, resolveEmbedder } from '../lib/core/env.js'
import { backfillEmbeddings } from '../lib/core/backfill.js'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-backfill-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('readEnvFile parses values, comments and quotes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, '.env')
  writeFileSync(path, [
    '# comment',
    'OPENAI_API_KEY="sk-test"',
    "OPENAI_EMBEDDING_MODEL='qwen3-embedding-8b'",
    'OPENAI_BASE_URL=https://example.test/v1',
    '',
  ].join('\n'))
  const env = readEnvFile(path)
  assert.equal(env.OPENAI_API_KEY, 'sk-test')
  assert.equal(env.OPENAI_EMBEDDING_MODEL, 'qwen3-embedding-8b')
  assert.equal(findEnvFile({ projectDir: dir }), path)
})

test('resolveEmbedder prefers the endpoint when a key exists, else the local one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const withKey = join(dir, '.env')
  writeFileSync(withKey, 'OPENAI_API_KEY=sk-test\nOPENAI_EMBEDDING_MODEL=qwen3-embedding-8b\n')
  const remote = resolveEmbedder({ projectDir: dir, env: {} })
  assert.ok(remote instanceof OpenAIEmbedder)
  assert.equal(remote.model, 'openai/qwen3-embedding-8b')

  const local = resolveEmbedder({ projectDir: join(dir, 'nowhere'), env: {} })
  assert.ok(local instanceof LocalEmbedder)
  assert.equal(local.model, 'local/384')
})

test('the OpenAI embedder keeps input order and normalises vectors', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((_text, index) => ({ index, embedding: index === 0 ? [3, 4] : [0, 5] })).reverse(),
      }),
    }
  }
  const embedder = new OpenAIEmbedder({ apiKey: 'k', model: 'm', fetchImpl })
  const vectors = await embedder.embed(['a', 'b'])
  assert.equal(calls.length, 1)
  assert.ok(Math.abs(vectors[0][0] - 0.6) < 1e-6 && Math.abs(vectors[0][1] - 0.8) < 1e-6)
  assert.deepEqual([...vectors[1]], [0, 1])
  assert.equal(embedder.dim, 2)
})

test('the OpenAI embedder throws on an HTTP error', async () => {
  const embedder = new OpenAIEmbedder({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 503 }) })
  await assert.rejects(() => embedder.embed(['a']), /503/)
})

test('backfill embeds only missing rows and is resumable', async (t) => {
  const store = openStore(t)
  const embedder = new LocalEmbedder(384)
  for (const text of ['用户偏好中文回答。', '用户在 SJS 项目里用 Postgres。', '用户住在南京。']) {
    store.addMemory({ userId: 'u1', text })
  }

  const first = await backfillEmbeddings(store, embedder, { batchSize: 2 })
  assert.equal(first.embedded, 3)
  assert.equal(store.stats().embeddings, 3)

  const second = await backfillEmbeddings(store, embedder, { batchSize: 2 })
  assert.equal(second.missing, 0)
  assert.equal(second.embedded, 0)
})
