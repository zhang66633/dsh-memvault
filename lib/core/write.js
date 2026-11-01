/**
 * The write pipeline in one call (M1): extract -> decide -> apply.
 *
 * Applying is where the new store differs from the Python engine: an update is
 * a `supersede` (new row, old row linked), never an in-place text change. Facts
 * from the same pass are related to each other by textual similarity so the
 * graph does not go flat, and every applied decision is reported back for the
 * panel and for tests.
 */
import { decideFacts, similarity } from './decide.js'

export async function remember({
  store,
  scope = {},
  messages,
  extractor,
  decider = null,
  metadata = {},
  origin = 'extract',
  embedder = null,
} = {}) {
  if (!store) throw new Error('store is required')
  if (!extractor) throw new Error('extractor is required')

  const facts = await extractor.extract(messages)
  const summary = { facts, added: 0, superseded: 0, skipped: 0, relations: 0, decisions: [] }
  if (!facts.length) return summary

  const decisions = await decideFacts(store, scope, facts, { decider })
  summary.decisions = decisions.map((decision) => ({
    fact: decision.fact,
    op: decision.op,
    targetId: decision.targetId ?? null,
    reason: decision.reason ?? null,
  }))

  const applied = []
  for (const decision of decisions) {
    if (decision.op === 'none') {
      summary.skipped += 1
      continue
    }
    if (decision.op === 'supersede' && decision.targetId) {
      applied.push(store.supersede(decision.targetId, {
        text: decision.fact,
        metadata,
        origin,
        actor: origin,
      }))
      summary.superseded += 1
      continue
    }
    applied.push(store.addMemory({
      ...scope,
      text: decision.fact,
      metadata,
      origin,
      actor: origin,
    }))
    summary.added += 1
  }

  for (let i = 0; i < applied.length; i += 1) {
    for (let j = i + 1; j < applied.length; j += 1) {
      const weight = similarity(applied[i].text, applied[j].text)
      if (weight > 0) {
        store.addRelation(applied[i].id, applied[j].id, 'similar', Math.round(weight * 10_000) / 10_000)
        summary.relations += 1
      }
    }
  }

  // Vectors are stored per applied memory so retrieval has something to score on
  // the very next search; the embedding model is the row key, so a later switch
  // to a real endpoint adds rows instead of losing the old ones.
  if (embedder && applied.length) {
    const vectors = await embedder.embed(applied.map((memory) => memory.text))
    applied.forEach((memory, index) => {
      if (vectors[index]) store.saveEmbedding(memory.id, embedder.model, vectors[index])
    })
  }
  // Ids and text of what was actually written: the extraction pipeline records
  // these as "produced" so a window stays traceable to its rows.
  summary.applied = applied.map((memory) => ({ id: memory.id, text: memory.text, type: memory.type }))
  return summary
}
