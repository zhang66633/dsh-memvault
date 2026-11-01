/**
 * Backfill the in-plugin store with embeddings for the selected model.
 *
 *   node scripts/backfill-core.mjs <db-path> [--project-dir <dir>] [--batch 32] [--apply]
 *
 * The embedder is resolved exactly like the plugin resolves it at runtime: the
 * project `.env` (or real environment) selects the OpenAI-compatible endpoint
 * when `OPENAI_API_KEY` is set, otherwise the offline hashing embedder. Dry-run
 * by default — it reports how many rows are missing a vector without spending a
 * single embedding call.
 */
import { resolveEmbedder } from '../lib/core/env.js'
import { backfillEmbeddings } from '../lib/core/backfill.js'
import { CoreStore } from '../lib/core/store.js'

const args = process.argv.slice(2)
const dbPath = args[0]
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}
const apply = args.includes('--apply')
const batchSize = Number(flag('--batch') ?? 32)

if (!dbPath || dbPath.startsWith('--')) {
  console.error('usage: node scripts/backfill-core.mjs <db-path> [--project-dir <dir>] [--batch 32] [--apply]')
  process.exit(2)
}

const embedder = resolveEmbedder({
  projectDir: flag('--project-dir') ?? '',
  dbPath,
})
const store = new CoreStore(dbPath)
try {
  const missing = store.db.prepare(`
    SELECT COUNT(*) AS n FROM memories
    WHERE id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
  `).get(embedder.model).n

  if (!apply) {
    console.log(JSON.stringify({ db: dbPath, model: embedder.model, missing, applied: false }, null, 2))
    process.exit(0)
  }

  const report = await backfillEmbeddings(store, embedder, {
    batchSize,
    onBatch: ({ done, total }) => console.error(`  embedded ${done}/${total}`),
  })
  console.log(JSON.stringify({ db: dbPath, ...report, stats: store.stats(), applied: true }, null, 2))
} finally {
  store.close()
}
