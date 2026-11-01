/**
 * M2 tools: the contract this plugin owns, tested without the Harness runtime.
 *
 * `defineTool` normally comes from `@deepseek-ai/dsh-tools`; the identity stub
 * here records the definition it was given, and the fake `ctx.tools` records
 * registration. What is asserted is what a broken wiring would silently lose:
 * the tool names, their required parameters, that execution reaches the store,
 * and that the disposer is returned.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { buildMemoryTools, registerMemoryTools } from '../lib/core/tools.js'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-tools-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('builds memory_search and memory_add with required parameters', (t) => {
  const store = openStore(t)
  const [search, add] = buildMemoryTools(store)
  assert.equal(search.name, 'memory_search')
  assert.deepEqual(search.parameters.required, ['query'])
  assert.equal(add.name, 'memory_add')
  assert.deepEqual(add.parameters.required, ['text'])
  assert.equal(search.output.render({}, { results: [] })[0].type, 'text')
})

test('memory_search executes against the store', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  const [search] = buildMemoryTools(store)
  const out = await search.execute({ query: '违规事件', user_id: 'u1' })
  assert.equal(out.results[0].text, '用户在 SJS 项目里用 Postgres 存违规事件。')
  assert.equal(out.answerable, true)
})

test('memory_search blanks results when nothing answers the question', async (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  const [search] = buildMemoryTools(store)
  const out = await search.execute({ query: '违规事件表有多少行', user_id: 'u1' })
  assert.deepEqual(out.results, [])
  assert.equal(out.answerable, false)
})

test('memory_add stores a memory and refuses an unscoped call', async (t) => {
  const store = openStore(t)
  const [, add] = buildMemoryTools(store)
  const out = await add.execute({ text: '用户偏好中文回答。', user_id: 'u1' })
  assert.equal(store.getMemory(out.id).text, '用户偏好中文回答。')
  await assert.rejects(() => add.execute({ text: '没有作用域' }), /scope/)
})

test('registerMemoryTools registers both and disposes them', (t) => {
  const store = openStore(t)
  const events = []
  const ctx = {
    tools: {
      register(tool) {
        events.push(`register:${tool.name}`)
        return () => events.push(`dispose:${tool.name}`)
      },
    },
  }
  const dispose = registerMemoryTools(ctx, { store })
  assert.deepEqual(events, ['register:memory_search', 'register:memory_add'])
  dispose()
  assert.deepEqual(events, [
    'register:memory_search', 'register:memory_add',
    'dispose:memory_search', 'dispose:memory_add',
  ])
})
