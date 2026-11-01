/**
 * Backfill: embed memories that have no vector for the selected model.
 *
 * Imported memories carry text but no embeddings (the export drops vectors by
 * default because they are model-specific). Until they are embedded, retrieval
 * on them is keyword-only — measurably worse than the old store's semantic
 * search — so the migration is not finished until this runs.
 *
 * Batched and resumable: only rows missing a vector for `embedder.model` are
 * selected, so re-running after an interruption continues where it stopped.
 */
export async function backfillEmbeddings(store, embedder, { batchSize = 32, onBatch = null } = {}) {
  const rows = store.db.prepare(`
    SELECT id, text FROM memories
    WHERE id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
    ORDER BY created_at
  `).all(embedder.model)

  let embedded = 0
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const vectors = await embedder.embed(batch.map((row) => row.text))
    batch.forEach((row, index) => {
      const vector = vectors[index]
      if (!vector) return
      store.saveEmbedding(row.id, embedder.model, vector)
      embedded += 1
    })
    onBatch?.({ done: Math.min(offset + batchSize, rows.length), total: rows.length })
  }
  return { model: embedder.model, missing: rows.length, embedded }
}
