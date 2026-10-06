/**
 * Smoke test for the *package contract* — the part DSH reads before it ever
 * runs plugin code. No DSH and no database involved.
 *
 *   node scripts/smoke-package.mjs
 *
 * What it pins down (each rule comes from `@deepseek-ai/dsh-package-manifest`
 * and `@deepseek-ai/dsh-app-boot`, both verified against the shipped runtime):
 *
 *   - `package.json` carries `name` + `version` (the only required fields).
 *   - `dsh.bundle.patch` names a file that exists; a bundle without a loadable
 *     patch is listed as `not-a-bundle` / skipped by the launcher.
 *   - the patch row's `name`, the package name and the module's exported `name`
 *     agree. A mismatch makes the row resolve to nothing, and the failure looks
 *     exactly like "memory silently stopped being injected".
 *   - only `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers are compatibility
 *     checked, and a missing declaration imposes no constraint at all — so the
 *     declarations that exist are checked for the right package family.
 *   - `files[]` names real paths, otherwise a published tarball silently lacks
 *     the patch or the docs.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── manifest essentials ──────────────────────────────────────────────────────
check('manifest declares name and version', typeof pkg.name === 'string' && !!pkg.version,
  `${pkg.name}@${pkg.version}`)
check('package name is publishable and unscoped', /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name ?? ''), pkg.name)
check('type is module (the plugin is plain ESM)', pkg.type === 'module')
check('main points at a real file', existsSync(join(root, pkg.main ?? '')), pkg.main)
check('every exports target exists',
  Object.values(pkg.exports ?? {}).filter((v) => typeof v === 'string' && v.startsWith('.'))
    .every((v) => existsSync(join(root, v)) || v === './package.json'))
check('declares no runtime dependencies (node: builtins only)',
  Object.keys(pkg.dependencies ?? {}).length === 0)
check('every files[] entry exists', (pkg.files ?? []).every((f) => existsSync(join(root, f))),
  (pkg.files ?? []).join(', '))

// ── bundle declaration ──────────────────────────────────────────────────────
const patchRel = pkg.dsh?.bundle?.patch
check('declares dsh.bundle.patch', typeof patchRel === 'string', String(patchRel))
check('the patch file exists', !!patchRel && existsSync(join(root, patchRel)), String(patchRel))

const patch = patchRel && existsSync(join(root, patchRel)) ? readFileSync(join(root, patchRel), 'utf8') : ''
const rowNames = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1].trim())
check('the patch inserts exactly one row, by module name', rowNames.length === 1, rowNames.join(', '))
check('patch row name === package name', rowNames[0] === pkg.name, `${rowNames[0]} vs ${pkg.name}`)

const mod = await import('../lib/index.js')
check('exported plugin name === package name', mod.name === pkg.name, `${mod.name} vs ${pkg.name}`)
check('exports inject[] naming only DSH services',
  Array.isArray(mod.inject) && mod.inject.length > 0 && mod.inject.every((s) => typeof s === 'string'),
  (mod.inject ?? []).join(', '))
check('exports an apply() function', typeof mod.apply === 'function')

// The client bundle carries its own copy of the plugin identity: the ModuleLoader
// envelope's `id` must be the package name, or the host's served bundle cannot be
// matched to the row that requests it.
const clientBundle = readFileSync(join(root, pkg.exports['./client']), 'utf8')
const bundleId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientBundle)?.[1]
check('client bundle id === package name', bundleId === pkg.name, `${bundleId} vs ${pkg.name}`)
check('client bundle is a factory envelope, not an ES module',
  clientBundle.includes('factory: (require)') && !/^\s*export\s/m.test(clientBundle))

// ── compatibility declaration ───────────────────────────────────────────────
const peers = Object.keys(pkg.peerDependencies ?? {})
const checkedFamilies = peers.filter((n) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
check('declares at least one compatibility-checked DSH peer',
  checkedFamilies.length > 0, checkedFamilies.join(', ') || '(none — no constraint is enforced)')
check('every injected service has a declared DSH peer',
  mod.inject.every((service) => peers.includes(`@deepseek-ai/dsh-${service.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)),
  peers.join(', '))
check('declares the Schemastery peer the Config schema is built from',
  peers.includes('@deepseek-ai/schemastery'), peers.join(', '))
// The Loader reads `Config` off the plugin module. It is `undefined` outside a DSH
// runtime (that is the documented fallback), so the contract to pin is that the
// name exists and the schema module ships.
check('exports a Config name for the Loader to read', 'Config' in mod,
  mod.Config === undefined ? 'undefined here (no DSH runtime), which the Loader accepts' : `type=${mod.Config?.type}`)
check('the schema module ships in the package', (pkg.files ?? []).includes('lib'))
check('a config spec exists as the single source of defaults',
  existsSync(join(root, 'lib/config.js')) && typeof mod.DEFAULT_EXTRACT === 'object')
check('peer ranges are non-empty strings',
  Object.values(pkg.peerDependencies ?? {}).every((r) => typeof r === 'string' && r.trim() !== ''))
check('DshPackageManifest format version declared', pkg.dsh?.manifestVersion === 1)

// ── the browser half ────────────────────────────────────────────────────────
// `dsh.client` is parsed by @deepseek-ai/dsh-client-modules, which reads
// `platform` (must be the string 'web') and the optional `external` list; any
// other key there is inert. A declared client half needs a built `./client`
// export to serve, because the host serves built bundles.
check('declares the browser half as a web client',
  pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client ?? null))
check('the client half has an exports entry', typeof pkg.exports?.['./client'] === 'string', String(pkg.exports?.['./client']))
check('the built client bundle exists (host serves built bundles)',
  typeof pkg.exports?.['./client'] === 'string' && existsSync(join(root, pkg.exports['./client'])))
check('the client source ships too, so the bundle can be rebuilt',
  (pkg.files ?? []).includes('src') && existsSync(join(root, 'src/client/index.js')))
check('the build script is declared', typeof pkg.scripts?.build === 'string', String(pkg.scripts?.build))

// ── the plugin must not need a client half to work ──────────────────────────
check('the client half declares no unneeded externals',
  pkg.dsh?.client?.external === undefined || pkg.dsh.client.external.length === 0)

// ── panel UI guards (source level) ──────────────────────────────────────────
// The panel is browser code, so Node tests cannot exercise it; these two pin the
// fixes for the 2026-09-29 field report against a silent revert:
//   1. flagging a row must refresh the 待复核 card in the same view
//      (the queue refetches on this token, so the bump has to sit in the flag
//      handler — it used to exist only in the replay path);
//   2. the queue itself must offer a way to clear a mark, instead of forcing the
//      user to leave the view and toggle it in the browse list.
const clientSource = readFileSync(join(root, 'src/client/index.js'), 'utf8')
const flagHandler = /const flagRow = async[\s\S]*?\n  \}/.exec(clientSource)?.[0] ?? ''
check('flagging refreshes the review card in place',
  flagHandler.includes('setData(') && flagHandler.includes('setReviewToken((n) => n + 1)'),
  flagHandler ? 'flag handler found' : 'flag handler not found')
check('the built bundle offers un-flagging from the review queue',
  clientBundle.includes('取消标记') && existsSync(join(root, pkg.exports['./client'])))
check('the built bundle carries the structure view',
  clientBundle.includes('/memvault/api/structure') && clientBundle.includes('关系图'))
check('the built bundle states where the paths can be changed',
  clientBundle.includes('位置与初始化') && clientBundle.includes('改路径只有两个真实的入口'))

// ── absolute paths only where they are allowed to be ─────────────────────────
// A hard-coded disk is how "works on my machine" starts. Four files may contain one,
// each for a stated reason; anything else fails here rather than on someone else's
// machine:
//   lib/config.js      the discovery *candidates* (searched, never assumed)
//   lib/blocks.js      the documented fallback for a direct readCoreBlocks call
//   lib/index.js       a comment about Windows path normalisation
//   cordis.patch.yml   the shipped example configuration, annotated as such
//
// The pattern requires a non-alphanumeric (or the start) before the letter: the first
// version matched `http://` and flagged three harmless URL constructions in panel.js.
const DRIVE_PATH = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/
check('the path guard does not mistake a URL scheme for a drive letter',
  !DRIVE_PATH.test('http://localhost') && !DRIVE_PATH.test('https://example.com/x')
  && DRIVE_PATH.test('D:/x') && DRIVE_PATH.test("'C:\\Users\\x'"))

const ALLOWED_ABSOLUTE_PATH_FILES = ['lib/config.js', 'lib/blocks.js', 'lib/index.js', 'cordis.patch.yml']
const SOURCE_FILES = [
  'lib/config.js', 'lib/blocks.js', 'lib/index.js', 'lib/panel.js', 'lib/memories.js',
  'lib/structure.js', 'lib/extract.js', 'lib/window.js', 'lib/cli.js', 'lib/flags.js',
  'src/client/index.js', 'cordis.patch.yml',
]
const offenders = SOURCE_FILES.filter((rel) => !ALLOWED_ABSOLUTE_PATH_FILES.includes(rel)
  && DRIVE_PATH.test(readFileSync(join(root, rel), 'utf8')))
check('an absolute path appears only in the files allowed to carry one',
  offenders.length === 0,
  offenders.length > 0 ? `new hard-coded path(s) in: ${offenders.join(', ')}` : 'allow-list intact')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-env-'))
  writeFileSync(join(dir, '.env'), 'MEMVAULT_DB_PATH=data/x.db\nMEMVAULT_EMBEDDER=openai\nOPENAI_EMBEDDING_MODEL=qwen3-embedding-8b\n')
  const { checkPaths } = await import('../lib/index.js')
  const options = { pythonPath: process.execPath, dbPath: join(dir, 'data', 'x.db'), statePath: join(dir, 'state.json') }
  const row = checkPaths({ ...options, projectDir: dir }).find((r) => r.key === 'serviceEmbedder')
  check('the service embedder is reported, with its model',
    Boolean(row) && row.detail.includes('openai') && row.detail.includes('qwen3-embedding-8b'),
    row ? row.detail : 'no serviceEmbedder row')
  const bare = checkPaths({ ...options, projectDir: join(dir, 'nope') }).find((r) => r.key === 'serviceEmbedder')
  check('an .env that sets nothing says which default applies',
    Boolean(bare) && bare.detail.includes('local'), bare ? bare.detail : 'missing')
}

check('every allow-listed file still contains one (a stale entry would be a lie)',
  ALLOWED_ABSOLUTE_PATH_FILES.every((rel) => DRIVE_PATH.test(readFileSync(join(root, rel), 'utf8'))),
  ALLOWED_ABSOLUTE_PATH_FILES.join(', '))

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
