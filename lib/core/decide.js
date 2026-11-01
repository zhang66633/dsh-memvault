/**
 * Write decisions (M1): add / supersede / none for each extracted fact.
 *
 * The rule path is deliberately conservative — it only supersedes when it can
 * name *why* (a duplicate, a negation, or the same attribute slot with real
 * textual overlap). Anything else becomes an ADD rather than silently replacing
 * a memory. When a chat client is configured, the model sees the same candidate
 * set and may choose the operation instead; every answer is validated against
 * that set, and an invalid or failed answer falls back to the rule per fact —
 * the same failure-open contract the Python engine settled on.
 */
import { DEFAULT_LLM_PROMPT } from './extract.js'

/** Character bigrams, punctuation and case folded away. */
export function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

/** Jaccard overlap of bigrams: cheap, language-agnostic, no model. */
export function similarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

const NEGATION = /(?:不|没|别|不再|不是|改用|改成|换成|现在用)/
const SLOTS = ['名字', '职业', '学校', '专业', '编辑器', '终端', '住址', '城市', '生日', '邮箱', '电话', '数据库', '端口', '路径']

/** Do both texts talk about the same attribute slot? */
export function sameSlot(a, b) {
  return SLOTS.some((slot) => a.includes(slot) && b.includes(slot))
}

export function ruleDecision(fact, candidates = []) {
  for (const candidate of candidates) {
    if (candidate.text === fact) {
      return { op: 'none', targetId: candidate.id, reason: 'exact duplicate' }
    }
    const score = similarity(fact, candidate.text)
    if (score < 0.3) continue
    if (NEGATION.test(fact)) {
      return { op: 'supersede', targetId: candidate.id, reason: 'negation' }
    }
    if (sameSlot(fact, candidate.text) && score >= 0.25) {
      // A slot change replaces its value ("编辑器是 VS Code" -> "编辑器是
      // Neovim"), so the overlap between the two texts is low by construction;
      // requiring a high score here would turn every such change into a second
      // fact. The slot itself is the evidence.
      return { op: 'supersede', targetId: candidate.id, reason: 'same slot' }
    }
  }
  return { op: 'add', targetId: null, reason: 'new fact' }
}

export const DECIDER_PROMPT = (
  '你是记忆库的写入决策器。给定若干条新事实，以及每条事实在库中的候选记忆，'
  + '为每条事实选择一个操作。只输出一个 JSON 数组，每项形如：'
  + '{"fact": 序号, "op": "add|update|delete|none", "target_id": "候选 id（update/delete 必填）", '
  + '"confidence": 0 到 1}。'
  + '规则：只是换了一种说法的同一件事 → update（选最接近的候选 id）；'
  + '新事实否定或替换旧事实 → delete（选被否定的 id）；'
  + '候选与事实完全相同、没有新信息 → none；否则 add。'
  + '不要输出解释，不要编造候选里没有的 id。'
)

/** Tolerant parse of the decider's JSON array, keyed by fact index. */
export function parseDecisions(content) {
  const text = String(content ?? '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  let data
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const out = new Map()
  for (const item of data) {
    const fact = Number(item?.fact)
    const op = String(item?.op ?? '').toLowerCase()
    if (!Number.isInteger(fact) || !['add', 'update', 'delete', 'none'].includes(op)) continue
    out.set(fact, {
      op: op === 'update' || op === 'delete' ? 'supersede' : op,
      targetId: typeof item?.target_id === 'string' ? item.target_id : null,
      confidence: Number(item?.confidence) || 0,
    })
  }
  return out.size ? out : null
}

export class LLMDecider {
  constructor(client) {
    this.client = client
  }

  async decide(facts, candidatesByFact, prompt = DECIDER_PROMPT) {
    const payload = facts.map((fact, index) => ({
      fact: index,
      text: fact,
      candidates: (candidatesByFact[index] || []).map((row) => ({ id: row.id, text: row.text })),
    }))
    const content = await this.client.complete([
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(payload) },
    ])
    return parseDecisions(content)
  }
}

function valid(decision, candidates) {
  if (!decision || !['add', 'supersede', 'none'].includes(decision.op)) return false
  if (decision.op !== 'supersede') return true
  return Boolean(decision.targetId) && candidates.some((row) => row.id === decision.targetId)
}

/**
 * Decide every fact: model answer when valid, rule decision otherwise.
 * Also returns the candidate set, so callers can report what the model saw.
 */
export async function decideFacts(store, scope, facts, { decider = null, limit = 3, poolLimit = 500 } = {}) {
  // Candidates are scored here, not by FTS: a trigram MATCH is an AND over the
  // query's trigrams, so a paraphrased fact ("…是李四" vs "…是张三") matches
  // nothing — exactly the case a write decision exists for. Scopes are small
  // enough (hundreds of rows) that scoring the current set is cheap.
  const pool = store.currentMemories({ ...scope, limit: poolLimit })
  const candidatesByFact = facts.map((fact) => pool
    .map((row) => ({ row, score: similarity(fact, row.text) }))
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.row))

  let model = null
  if (decider && facts.length) {
    try {
      model = await decider.decide(facts, candidatesByFact)
    } catch {
      model = null
    }
  }
  return facts.map((fact, index) => {
    const candidates = candidatesByFact[index]
    const fromModel = model?.get(index)
    if (fromModel && valid(fromModel, candidates)) {
      return { fact, ...fromModel, reason: 'model' }
    }
    return { fact, ...ruleDecision(fact, candidates) }
  })
}

export { DEFAULT_LLM_PROMPT }
