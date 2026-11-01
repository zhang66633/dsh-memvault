/**
 * M1 acceptance: extraction, decisions and supersede through the new store.
 *
 * No network: the LLM paths are exercised with a fake `fetchImpl`, and the rule
 * paths use the deterministic extractor. What is asserted is behaviour, not
 * prompt text: a duplicate is skipped, a changed name supersedes instead of
 * stacking, and facts from one pass land in the relation graph.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { ChatClient } from '../lib/core/llm.js'
import { RuleExtractor, LLMExtractor, parseFacts } from '../lib/core/extract.js'
import {
  LLMDecider, decideFacts, parseDecisions, ruleDecision, similarity,
} from '../lib/core/decide.js'
import { remember } from '../lib/core/write.js'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-m1-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

function fakeClient(content) {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  })
  return new ChatClient({ apiKey: 'test', fetchImpl })
}

// ── extraction ─────────────────────────────────────────────────────────────

test('the rule extractor turns self-disclosure into facts', () => {
  const facts = new RuleExtractor().extract([
    { role: 'user', content: '我叫张三，我喜欢吃辣。' },
    { role: 'assistant', content: '我记住了你喜欢吃辣。' },
  ])
  assert.ok(facts.includes('用户的名字是张三'))
  assert.ok(facts.includes('用户喜欢吃辣'))
  assert.equal(facts.filter((fact) => fact.includes('记住了')).length, 0)
})

test('parseFacts tolerates fences and returns [] on garbage', () => {
  assert.deepEqual(parseFacts('```json\n["用户喜欢猫"]\n```'), ['用户喜欢猫'])
  assert.deepEqual(parseFacts('not json'), [])
})

test('the LLM extractor sends only user turns and parses the answer', async () => {
  let seen = ''
  const client = new ChatClient({
    apiKey: 'test',
    fetchImpl: async (url, init) => {
      seen = init.body
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["用户喜欢猫"]' } }] }) }
    },
  })
  const facts = await new LLMExtractor(client).extract([
    { role: 'user', content: '我喜欢猫' },
    { role: 'assistant', content: '收到' },
  ])
  assert.deepEqual(facts, ['用户喜欢猫'])
  assert.ok(seen.includes('我喜欢猫'))
  assert.equal(seen.includes('收到'), false)
})

// ── decisions ──────────────────────────────────────────────────────────────

test('similarity prefers close paraphrases over unrelated text', () => {
  assert.ok(similarity('用户的名字是张三', '用户的名字是李四') > 0.5)
  assert.ok(similarity('用户的名字是张三', 'SJS 周更每天 02:00 跑') < 0.2)
})

test('ruleDecision skips duplicates and supersedes a changed slot', () => {
  const duplicate = ruleDecision('用户的名字是张三', [{ id: 'm1', text: '用户的名字是张三' }])
  assert.equal(duplicate.op, 'none')
  const changed = ruleDecision('用户的名字是李四', [{ id: 'm1', text: '用户的名字是张三' }])
  assert.equal(changed.op, 'supersede')
  assert.equal(changed.targetId, 'm1')
  const fresh = ruleDecision('用户喜欢猫', [{ id: 'm1', text: '用户的名字是张三' }])
  assert.equal(fresh.op, 'add')
})

test('parseDecisions maps update/delete onto supersede and drops junk', () => {
  const parsed = parseDecisions('[{"fact":0,"op":"update","target_id":"m1"},{"fact":1,"op":"merge"}]')
  assert.equal(parsed.size, 1)
  assert.equal(parsed.get(0).op, 'supersede')
  assert.equal(parsed.get(0).targetId, 'm1')
})

test('the model decision is used only when it names a real candidate', async (t) => {
  const store = openStore(t)
  const existing = store.addMemory({ userId: 'u1', text: '用户的编辑器是 VS Code。' })

  const good = new LLMDecider(fakeClient(JSON.stringify([
    { fact: 0, op: 'update', target_id: existing.id, confidence: 0.9 },
  ])))
  const decisions = await decideFacts(store, { userId: 'u1' }, ['用户的编辑器是 Neovim。'], { decider: good })
  assert.equal(decisions[0].op, 'supersede')
  assert.equal(decisions[0].targetId, existing.id)
  assert.equal(decisions[0].reason, 'model')

  // A hallucinated id is not a licence to write: the rule policy decides.
  const bad = new LLMDecider(fakeClient(JSON.stringify([
    { fact: 0, op: 'update', target_id: 'mem_invented' },
  ])))
  const fallback = await decideFacts(store, { userId: 'u1' }, ['用户的编辑器是 Neovim。'], { decider: bad })
  assert.equal(fallback[0].op, 'supersede')
  assert.equal(fallback[0].targetId, existing.id)
  assert.equal(fallback[0].reason, 'same slot')
})

// ── the whole write path ───────────────────────────────────────────────────

test('remember adds, then supersedes a changed name instead of stacking', async (t) => {
  const store = openStore(t)
  const extractor = new RuleExtractor()

  const first = await remember({
    store, scope: { userId: 'u1' },
    messages: [{ role: 'user', content: '我叫张三，我喜欢吃辣。' }],
    extractor,
  })
  assert.equal(first.added, 2)
  assert.equal(first.relations, 1)

  const second = await remember({
    store, scope: { userId: 'u1' },
    messages: [{ role: 'user', content: '我叫李四。' }],
    extractor,
  })
  assert.equal(second.superseded, 1)

  const names = store.currentMemories({ userId: 'u1' }).filter((memory) => memory.text.includes('名字'))
  assert.equal(names.length, 1)
  assert.equal(names[0].text, '用户的名字是李四')
})

test('remember reports skipped duplicates without writing', async (t) => {
  const store = openStore(t)
  const extractor = new RuleExtractor()
  const messages = [{ role: 'user', content: '我叫张三。' }]
  await remember({ store, scope: { userId: 'u1' }, messages, extractor })
  const again = await remember({ store, scope: { userId: 'u1' }, messages, extractor })
  assert.equal(again.skipped, 1)
  assert.equal(again.added, 0)
  assert.equal(store.currentMemories({ userId: 'u1' }).length, 1)
})
