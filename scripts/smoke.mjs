/**
 * Smoke test for the reader + formatter, with no DSH involved.
 *
 *   node scripts/smoke.mjs [dbPath]
 *
 * Exits non-zero on failure so it is usable as a check.
 */
import { DEFAULT_DB_PATH, DEFAULT_SCOPES, formatCoreBlocks, readCoreBlocks } from '../lib/blocks.js'

const dbPath = process.argv[2] ?? DEFAULT_DB_PATH
const failures = []

function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

console.log(`db: ${dbPath}`)
console.log('scopes:', DEFAULT_SCOPES.map((s) => `${s.type}/${s.id}`).join(', '))

const all = readCoreBlocks({ dbPath })
console.log(`\nall blocks in the configured scopes: ${all.length}`)
for (const b of all) console.log(`  [${b.scopeType}/${b.scopeId}/${b.label}] ${b.value}`)

check('reader returns an array', Array.isArray(all))
check('every block has a non-empty value', all.every((b) => b.value.length > 0))

const scoped = readCoreBlocks({ dbPath, scopes: [{ type: 'user', id: 'wang-fang' }] })
check('explicit scope filter works', scoped.every((b) => b.scopeId === 'wang-fang'),
  `${scoped.length} block(s)`)

const labelled = readCoreBlocks({ dbPath, scopes: [{ type: 'user', id: 'wang-fang' }], labels: ['persona'] })
check('label filter works', labelled.length <= 1 && labelled.every((b) => b.label === 'persona'),
  `${labelled.length} block(s)`)

check('unknown scope yields nothing', readCoreBlocks({ dbPath, scopes: [{ type: 'user', id: 'nope' }] }).length === 0)

const text = formatCoreBlocks(labelled, { maxChars: 4000 })
check('formatter renders numbered entries', labelled.length === 0 || text.includes('[user/wang-fang/persona]'),
  text.split('\n')[1] ?? '(empty)')

check('formatter returns empty string for no blocks', formatCoreBlocks([]) === '')

// Budget contract: maxChars bounds the WHOLE string (header included), and the
// header is always emitted, so a budget below the header length yields the header
// alone. These assertions only bite once there are blocks to place.
{
  const mid = formatCoreBlocks(all, { maxChars: 320 })
  check('budget: a mid budget stays within it', all.length === 0 || mid.length <= 320,
    `len=${mid.length} of 320`)
  const headerOnly = formatCoreBlocks(all, { maxChars: 1 })
  check('budget: a tiny budget yields the header alone',
    all.length === 0 || headerOnly === headerOnly.split('\n')[0],
    `header_len=${headerOnly.length}`)
  const full = formatCoreBlocks(all, { maxChars: 4000 })
  check('budget: the default budget keeps every block',
    all.length === 0 || full.split('\n').length === all.length + 1,
    `lines=${full.split('\n').length} vs blocks=${all.length}`)
}

check('missing db fails soft (throws, caller catches)', (() => {
  try { readCoreBlocks({ dbPath: 'D:/nonexistent/nope.db' }); return false } catch { return true }
})())

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
