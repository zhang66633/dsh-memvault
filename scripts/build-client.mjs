/**
 * dsh-memvault — client bundle build (zero dependencies, no bundler).
 *
 * The DSH client module system owns both halves of the wire: the host serves
 * built bundles under `/plugins`, and the browser materializes one as
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * This package's browser half has no npm imports of its own — everything it uses
 * is a platform module the shell already seeds — so producing that envelope is
 * the entire build. esbuild (what the sibling plugins use) would emit the same
 * two lines around the same body, and would add a dependency this package does
 * not otherwise need.
 *
 *   node scripts/build-client.mjs
 *
 * `lib/client.js` is committed: the host serves built bundles and fails the
 * bundle loudly when the file is missing, so it must exist before launch.
 * The file carries the sha256 of its source, and `scripts/smoke-panel.mjs`
 * re-derives it — a stale bundle fails the test instead of silently shipping an
 * old panel.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const { name: id } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/** Wrap the factory body in the ModuleLoader envelope; also the freshness check's reference. */
export function wrapClientBundle(source, bundleId = id) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(bundleId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    `// generated from src/client/index.js by scripts/build-client.mjs — do not edit`,
    `// source-sha256: ${digest}`,
    source.replace(/\n?$/, '\n'),
    `return module.exports; } });`,
    `//# sourceSHA256=${digest}`,
    '',
  ].join('\n')
}

const sourcePath = fileURLToPath(new URL('src/client/index.js', root))
const outPath = fileURLToPath(new URL('lib/client.js', root))
const source = readFileSync(sourcePath, 'utf8')
const wrapped = wrapClientBundle(source)

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(outPath, wrapped, 'utf8')
  console.log(`built lib/client.js (bundle id "${id}", ${wrapped.length} bytes)`)
}
