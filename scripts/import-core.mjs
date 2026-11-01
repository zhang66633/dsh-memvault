/**
 * Import a `memvault-export` JSON into the in-plugin store.
 *
 *   node scripts/import-core.mjs <export.json> <db-path> [--apply]
 *
 * Dry-run by default: it reports how many memories/blocks/relations would be
 * added and the store's current size. `--apply` performs the import, which is
 * idempotent by memory id — running it twice skips what is already there.
 *
 * This is the operational half of the migration: the Python store is exported
 * once (`memvault export`), imported here, and then retired.
 */
import { readFileSync, statSync } from 'node:fs'

import { importMemvaultExport } from '../lib/core/importers.js'
import { CoreStore } from '../lib/core/store.js'

const [exportPath, dbPath, ...flags] = process.argv.slice(2)
if (!exportPath || !dbPath) {
  console.error('usage: node scripts/import-core.mjs <export.json> <db-path> [--apply]')
  process.exit(2)
}
const apply = flags.includes('--apply')
const payload = JSON.parse(readFileSync(exportPath, 'utf8'))
if (payload.format !== 'memvault-export') {
  console.error(`not a memvault-export payload: ${payload.format ?? '(no format)'}`)
  process.exit(1)
}

const store = new CoreStore(dbPath)
try {
  const before = store.stats()
  const existing = new Set(store.currentMemories({ limit: 1_000_000 }).map((memory) => memory.id))
  const wouldAdd = (payload.memories ?? []).filter((memory) => !existing.has(memory.id)).length
  const summary = {
    export: {
      path: exportPath,
      bytes: statSync(exportPath).size,
      memories: payload.memories?.length ?? 0,
      blocks: payload.blocks?.length ?? 0,
      relations: payload.relations?.length ?? 0,
    },
    store: { path: dbPath, before },
    wouldAdd,
  }

  if (!apply) {
    console.log(JSON.stringify({ ...summary, applied: false }, null, 2))
    process.exit(0)
  }

  const report = importMemvaultExport(store, payload)
  console.log(JSON.stringify({ ...summary, applied: true, report, after: store.stats() }, null, 2))
} finally {
  store.close()
}
