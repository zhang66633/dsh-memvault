/**
 * Smoke test for the configuration layer: the spec, the resolver, and — when the
 * machine has a DSH install — the native schema built from the same spec.
 *
 *   node scripts/smoke-config.mjs
 *
 * Two of the groups below need packages that only a DSH installation has
 * (`@deepseek-ai/schemastery`, `js-yaml`). They are reported as SKIP with the
 * directory that was searched instead of passing silently: the plugin itself must
 * stay loadable on plain Node, but "we could not check" is not "it is fine".
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_DB_PATH, DEFAULT_SCOPES } from '../lib/blocks.js'
import { DEFAULT_STATE_PATH } from '../lib/extract.js'
import {
  CONFIG_SPEC,
  MEMVAULT_DIR,
  MEMVAULT_PYTHON,
  configDefaults,
  resolveConfig,
} from '../lib/config.js'
import { buildConfigSchema } from '../lib/schema.js'
import { DEFAULT_EXTRACT } from '../lib/index.js'
import { DEFAULT_WINDOW } from '../lib/window.js'

const failures = []
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
function skip(label, reason) {
  console.log(`  [SKIP] ${label} -- ${reason}`)
}

const same = (a, b) => isDeepStrictEqual(a, b)
const defaults = configDefaults()

// ── one description of every knob ───────────────────────────────────────────
{
  check('the spec defaults carry the documented values',
    defaults.enabled === true && defaults.name === 'memvault:core' && defaults.order === 210
    && defaults.maxChars === 4000 && defaults.refreshMs === 30000 && defaults.panel.writes === true,
    JSON.stringify({ name: defaults.name, maxChars: defaults.maxChars }))
  check('the spec default for dbPath is the env-aware one from blocks.js',
    defaults.dbPath === DEFAULT_DB_PATH, String(defaults.dbPath))
  check('the spec defaults for scopes are the reader defaults',
    same(defaults.scopes, DEFAULT_SCOPES), JSON.stringify(defaults.scopes))
  check('the spec default for statePath is the storage path from extract.js',
    defaults.extract.statePath === DEFAULT_STATE_PATH, String(defaults.extract.statePath))
  check('the extraction defaults come from the spec with the window policy',
    defaults.extract.everyNTurns === 3 && defaults.extract.idleMs === 20000
    && defaults.extract.windowTurns === 8 && defaults.extract.endReasons.join(',') === 'completed,max-tokens'
    && defaults.extract.env.PYTHONUTF8 === '1',
    JSON.stringify({ ...defaults.extract, env: undefined }))
  check('the portability defaults are the env-aware paths',
    defaults.extract.pythonPath === MEMVAULT_PYTHON && defaults.extract.projectDir === MEMVAULT_DIR)

  check('DEFAULT_EXTRACT is exactly the spec default (no second copy)',
    same(DEFAULT_EXTRACT, defaults.extract))
  check('window.js defaults agree with the spec (the one duplicated constant)',
    DEFAULT_WINDOW.everyNTurns === defaults.extract.everyNTurns
    && DEFAULT_WINDOW.idleMs === defaults.extract.idleMs
    && DEFAULT_WINDOW.windowTurns === defaults.extract.windowTurns,
    JSON.stringify(DEFAULT_WINDOW))

  // Inner `of` nodes are synthetic (they describe array elements, not a knob), so
  // descriptions and defaults are asserted on named fields only.
  const named = []
  const every = []
  const walk = (node, path, isField) => {
    every.push({ node, path })
    if (node.kind === 'object') {
      for (const [key, child] of Object.entries(node.fields ?? {})) walk(child, path ? `${path}.${key}` : key, true)
      return
    }
    if (isField) named.push({ node, path })
    if (node.kind === 'array' && node.of) walk(node.of, `${path}[]`, false)
  }
  walk({ kind: 'object', fields: CONFIG_SPEC }, '', true)
  check('every named field carries a description (the Plugins page renders them)',
    named.every(({ node }) => typeof node.description === 'string' && node.description.length > 10),
    `${named.length} fields, missing: ${named.filter(({ node }) => !node.description).map((l) => l.path).join(', ')}`)
  check('every named field has a default',
    named.every(({ node }) => node.default !== undefined),
    named.filter(({ node }) => node.default === undefined).map((l) => l.path).join(', '))
  check('every node kind is one the schema builder implements',
    every.every(({ node }) => ['string', 'number', 'boolean', 'enum', 'dict', 'array', 'object'].includes(node.kind)),
    [...new Set(every.map((l) => l.node.kind))].join(','))
  check('numeric fields declare integer-ness',
    every.filter(({ node }) => node.kind === 'number').every(({ node }) => node.integer === true))
  // Guard the step rule the schema follows: `step` is measured from `min`.
  check('a declared step divides the gap between min and the default',
    every.filter(({ node }) => node.step !== undefined && node.default !== undefined).every(({ node }) => {
      const base = node.min ?? 0
      return typeof node.default === 'number' && (node.default - base) % node.step === 0
    }),
    every.filter(({ node }) => node.step !== undefined && node.default !== undefined && typeof node.default === 'number'
      && (node.default - (node.min ?? 0)) % node.step !== 0).map((l) => l.path).join(', '))
}

// ── resolving a config ──────────────────────────────────────────────────────
{
  check('an empty config resolves to the defaults', same(resolveConfig({}).config, defaults))
  check('an empty config reports nothing',
    resolveConfig({}).unknown.length === 0 && resolveConfig({}).problems.length === 0)

  const partial = resolveConfig({ maxChars: 900, extract: { everyNTurns: 5 }, panel: { writes: false } })
  check('nested objects merge instead of replacing',
    partial.config.maxChars === 900 && partial.config.extract.everyNTurns === 5
    && partial.config.extract.windowTurns === 8 && partial.config.extract.statePath === DEFAULT_STATE_PATH
    && partial.config.panel.writes === false,
    JSON.stringify({ everyNTurns: partial.config.extract.everyNTurns, windowTurns: partial.config.extract.windowTurns }))

  const coerced = resolveConfig({ refreshMs: '45000' })
  check('a numeric string is coerced (and reported)',
    coerced.config.refreshMs === 45000 && coerced.problems.some((p) => p.includes('coerced')),
    coerced.problems.join('; '))

  const unknown = resolveConfig({ nope: 1, extract: { wat: 2 } })
  check('unknown keys are reported and ignored',
    same([...unknown.unknown].sort(), ['extract.wat', 'nope']) && unknown.config.nope === undefined
    && unknown.config.extract.wat === undefined,
    JSON.stringify(unknown.unknown))

  const wrong = resolveConfig({ maxChars: 'abc', enabled: 'yes', scopes: 'nope' })
  check('a wrong type falls back to the default and is reported',
    wrong.config.maxChars === 4000 && wrong.config.enabled === true && same(wrong.config.scopes, DEFAULT_SCOPES)
    && wrong.problems.length === 3,
    wrong.problems.join('; '))

  const env = resolveConfig({ extract: { env: { PYTHONUTF8: '1', BAD: 7 } } })
  check('a non-string env entry is dropped and reported',
    same(env.config.extract.env, { PYTHONUTF8: '1' }) && env.problems.some((p) => p.includes('extract.env.BAD')),
    env.problems.join('; '))

  const nullable = resolveConfig({ extract: { run: null } })
  check('null means "not set", so the default stands (empty run omits the flag)',
    nullable.config.extract.run === '' && same(nullable.config, defaults))

  const reasons = resolveConfig({ extract: { endReasons: ['completed'] } })
  check('an array field is replaced wholesale', same(reasons.config.extract.endReasons, ['completed']))

  // The shape the shipped patch actually uses — keeping this green is what stops
  // the patch and the spec from drifting apart.
  const patchShaped = {
    dbPath: 'D:/Claude_code/memory/data/memvault.db',
    scopes: [{ type: 'user', id: 'lenovo' }, { type: 'agent', id: 'claude-code-memory' }],
    labels: [],
    maxChars: 4000,
    refreshMs: 30000,
    panel: { writes: true },
    extract: {
      enabled: true,
      everyNTurns: 3,
      idleMs: 20000,
      windowTurns: 8,
      includeAssistant: false,
      includeTools: false,
      maxInputChars: 6000,
      minTranscriptChars: 40,
      timeoutMs: 120000,
      pythonPath: 'D:/Claude_code/memory/.venv/Scripts/python.exe',
      projectDir: 'D:/Claude_code/memory',
      user: 'lenovo',
      agent: 'claude-code-memory',
    },
  }
  const fromPatch = resolveConfig(patchShaped)
  check('a patch-shaped config resolves with nothing unknown and nothing wrong',
    fromPatch.unknown.length === 0 && fromPatch.problems.length === 0,
    [...fromPatch.unknown, ...fromPatch.problems].join('; '))
  check('the resolved patch config keeps every written value',
    fromPatch.config.maxChars === 4000 && fromPatch.config.extract.everyNTurns === 3
    && fromPatch.config.extract.idleMs === 20000 && fromPatch.config.scopes.length === 2)
}

// ── the native schema (needs a DSH install) ─────────────────────────────────
const profilesModules = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules')
const require = createRequire(import.meta.url)
const loadOptional = (name) => {
  const dir = join(profilesModules, ...name.split('/'))
  if (!existsSync(join(dir, 'package.json'))) return null
  try {
    return require(dir)
  } catch {
    return null
  }
}

const schemastery = loadOptional('@deepseek-ai/schemastery')
if (schemastery === null) {
  skip('the native Config schema', `no @deepseek-ai/schemastery under ${profilesModules}`)
} else {
  const Schema = schemastery.default ?? schemastery
  const Config = buildConfigSchema(Schema)

  // app-boot's own admission test for a native schema (verified in its source):
  // the global symbol, a string `type`, and an object `meta`.
  check('the schema is native by app-boot’s test',
    Reflect.get(Config, Symbol.for('schemastery')) === true
    && typeof Reflect.get(Config, 'type') === 'string'
    && typeof Reflect.get(Config, 'meta') === 'object' && Reflect.get(Config, 'meta') !== null,
    `type=${Config.type}`)
  check('the schema validates an empty config into exactly the code defaults',
    same(Config({}), defaults))
  check('the schema fills nested defaults for a partial config',
    same(Config({ maxChars: 900, extract: { idleMs: 5000 } }),
      { ...defaults, maxChars: 900, extract: { ...defaults.extract, idleMs: 5000 } }))
  check('the schema rejects a value below the declared minimum',
    (() => { try { Config({ maxChars: 10 }); return false } catch { return true } })())
  check('the schema rejects a wrong type',
    (() => { try { Config({ enabled: 'yes' }); return false } catch { return true } })())
  check('the schema carries descriptions into its metadata',
    JSON.stringify(Config.toJSON()).includes('KV-cache prefix'),
    'cache knob description')
  check('the schema exposes an object graph for projection',
    Config.toJSON() !== null && typeof Config.toJSON() === 'object' && typeof Config.toJSON().refs === 'object'
    && Object.keys(Config.toJSON().refs).length > 5,
    `${Object.keys(Config.toJSON().refs).length} refs`)
  const json = Config.toJSON()
  const extractRef = Object.values(json.refs).find((entry) => entry.type === 'object'
    && entry.dict && Object.hasOwn(entry.dict, 'windowTurns'))
  check('the projected graph contains the window knobs', extractRef !== undefined)
}

// ── the shipped patch against the spec (needs js-yaml) ──────────────────────
const yaml = loadOptional('js-yaml')
if (yaml === null) {
  skip('the shipped cordis.patch.yml against the spec', `no js-yaml under ${profilesModules}`)
} else {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = yaml.load(text)
  const row = rows?.[0]?.insert?.[0]
  check('the patch inserts the plugin row', row?.name === 'dsh-memvault', String(row?.name))
  const fromYaml = resolveConfig(row?.config ?? {})
  check('every key in the shipped patch is a declared field',
    fromYaml.unknown.length === 0, fromYaml.unknown.join(', '))
  check('every value in the shipped patch type-checks',
    fromYaml.problems.length === 0, fromYaml.problems.join('; '))
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
