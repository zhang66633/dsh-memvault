/**
 * Retrieval (M2): keyword + vector, fused with RRF.
 *
 * Score fusion, not score addition: the Python engine measured that a weighted
 * blend of cosine and keyword scores is not comparable across queries and that
 * its 0.55 threshold could not separate "related" from "answers the question".
 * Reciprocal Rank Fusion only looks at positions, so a bad absolute score cannot
 * poison the ranking, and a missing channel simply contributes nothing.
 *
 * The answerability guard is the same content check the Python engine settled
 * on: if the question asks for a number / time / port and the best candidate has
 * no such datum, the answer cannot be in the store, however high it ranked.
 */

const COUNT = /多少|多大|多长|多重|几[个条行次天年位种]|数量|行数|条数|个数/
const TIME = /几点|什么时候|何时|哪天|多久|多长时间/
const PORT = /端口/
const DIGIT = /\d/
const TIME_WORD = /每天|每周|每月|每年|每季度|周[一二三四五六日天]|点|分钟|小时|秒|上午|下午|晚上/

export const RRF_K = 60

/** 'reject' when no candidate can contain the demanded datum, else 'unknown'. */
export function answerabilityGuard(query, texts = []) {
  const kinds = []
  if (PORT.test(query)) kinds.push('port')
  if (COUNT.test(query)) kinds.push('count')
  if (TIME.test(query)) kinds.push('time')
  if (!kinds.length) return 'unknown'
  const bodies = texts.filter(Boolean)
  if (!bodies.length) return 'reject'
  if (kinds.includes('port') && !bodies.some((text) => DIGIT.test(text))) return 'reject'
  if (kinds.includes('count') && !bodies.some((text) => DIGIT.test(text))) return 'reject'
  if (kinds.includes('time') && !bodies.some((text) => DIGIT.test(text) || TIME_WORD.test(text))) {
    return 'reject'
  }
  return 'unknown'
}

function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
  return out
}

function overlap(query, text) {
  const left = bigrams(query)
  const right = bigrams(text)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / left.size
}

/** Keyword ranking: FTS5 for >=3 characters, LIKE/overlap otherwise. */
function keywordRanking(store, pool, term) {
  const allowed = new Set(pool.map((row) => row.id))
  if ([...term].length >= 3) {
    try {
      const rows = store.db.prepare(`
        SELECT m.id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.superseded_by IS NULL
        ORDER BY bm25(memories_fts) LIMIT 200
      `).all(term)
      const hits = rows.map((row) => row.id).filter((id) => allowed.has(id))
      if (hits.length) return hits
    } catch {
      // A malformed MATCH falls through to the overlap scan.
    }
  }
  return pool
    .map((row) => ({ id: row.id, score: overlap(term, row.text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}

function vectorRanking(store, pool, embedder, term) {
  if (!embedder) return []
  const vectors = store.vectorMap(embedder.model)
  if (!vectors.size) return []
  const queryVec = embedder.embedOne(term)
  return pool
    .filter((row) => vectors.has(row.id))
    .map((row) => ({ id: row.id, score: cosineOf(queryVec, vectors.get(row.id)) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id)
}

function cosineOf(a, b) {
  let dot = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i]
  return dot
}

/**
 * Search the current memories in a scope.
 *
 * @returns {{ results: object[], best: number|null, lowConfidence: boolean,
 *             answerable: boolean|null, note: string|null,
 *             keyword: number, vector: number }}
 */
export function searchMemories(store, query, {
  userId = null,
  agentId = null,
  runId = null,
  limit = 10,
  embedder = null,
  poolLimit = 2000,
} = {}) {
  const term = String(query ?? '').trim()
  const pool = store.currentMemories({ userId, agentId, runId, limit: poolLimit })
  if (!term || !pool.length) {
    return { results: [], best: null, lowConfidence: false, answerable: null, note: 'no memories in scope', keyword: 0, vector: 0 }
  }

  const keyword = keywordRanking(store, pool, term)
  const vector = vectorRanking(store, pool, embedder, term)

  const byId = new Map(pool.map((row) => [row.id, row]))
  const fused = new Map()
  const add = (ids, channel) => {
    ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, keywordRank: null, vectorRank: null }
      entry.score += 1 / (RRF_K + rank + 1)
      entry[`${channel}Rank`] = rank
      fused.set(id, entry)
    })
  }
  add(keyword, 'keyword')
  add(vector, 'vector')

  const results = [...fused.entries()]
    .map(([id, entry]) => ({ ...byId.get(id), ...entry }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const best = results.length ? results[0].score : null
  const answerable = answerabilityGuard(term, results.slice(0, 1).map((row) => row.text)) === 'reject'
    ? false
    : null

  return {
    results,
    best,
    lowConfidence: false,
    answerable,
    note: answerable === false
      ? 'the closest memories are related but do not answer the question'
      : null,
    keyword: keyword.length,
    vector: vector.length,
  }
}
