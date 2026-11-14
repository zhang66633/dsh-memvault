/**
 * The plugin's whole configuration, described once.
 *
 * Everything else derives from {@link CONFIG_SPEC}: the code defaults, the
 * schema DSH validates and the Plugins page renders, and the panel's view of what
 * is configured. Before this existed, defaults lived in three places (the
 * `DEFAULT_*` constants, the patch file, the README) and drifted.
 *
 * The description language is deliberately tiny — this module imports nothing but
 * Node builtins and the plugin's own constants, so the smoke tests can run it on
 * plain Node. `lib/schema.js` turns the same spec into a native Schemastery schema
 * when DSH provides one.
 *
 * Node kinds: `object`, `array`, `string`, `number`, `boolean`, `enum`, `dict`.
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCOPES } from './blocks.js'
import { DEFAULT_STATE_PATH } from './extract.js'

/** This package's own root — used as one place to look for a sibling checkout. */
const DEFAULT_PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Find the MemVault directory whose `.env` the pipeline should read.
 *
 * Since the Python engine retired (DEVLOG §34) nothing is spawned and no MemVault
 * checkout is needed: the only file the runtime still reads from a project
 * directory is its `.env` (embedding endpoint, extractor choice, model overrides).
 * So the test for a candidate is **does it hold a `.env`** — not "does it have a
 * `memvault/` package and a venv", which was the Python-era requirement and made
 * discovery fail on machines that had a perfectly good `.env` but no venv.
 *
 * Order matters and is deliberate:
 *
 * 1. `MEMVAULT_DIR` — an explicit answer always wins, even when it is wrong; the
 *    panel then reports the failure instead of silently using another vault.
 * 2. the store's own directory (`~/.dsh/memvault`, where the pipeline also looks
 *    for a `.env` next to the database), then the author's conventional location
 *    and a few common ones;
 * 3. nothing found — `projectDir` stays empty and the panel says so, listing what
 *    was checked. An empty project directory is not an error: the pipeline still
 *    finds a `.env` next to the store, and without one it falls back to the
 *    offline embedder and the rule extractor.
 */
export function discoverVault({ env = process.env, pluginDir = DEFAULT_PLUGIN_DIR } = {}) {
  const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
  const join = (...parts) => parts.join('/').replace(/\/+/g, '/')

  const explicitDir = env.MEMVAULT_DIR
  const candidates = [
    explicitDir,
    join(homedir(), '.dsh', 'memvault'),
    'D:/Claude_code/memory',
    join(homedir(), 'memvault'),
    join(homedir(), 'projects', 'memvault'),
    join(pluginDir, '..', 'memory'),
  ].filter((dir) => typeof dir === 'string' && dir !== '')

  const checked = []
  const explicit = typeof explicitDir === 'string' && explicitDir !== ''
  for (const dir of [...new Set(candidates)]) {
    const hasEnv = isFile(`${dir}/.env`)
    checked.push({ dir, hasEnv })
    if (hasEnv) {
      return { found: true, source: dir === explicitDir ? 'env' : 'discovered', projectDir: dir, checked }
    }
    // An explicit answer wins even when it is wrong: substituting a working
    // directory for the one the user named is how "my memories are in the other
    // vault" happens.
    if (explicit) break
  }
  return {
    found: false,
    source: explicit ? 'env' : 'none',
    // Empty, not a guess: the default `projectDir` must not claim a directory the
    // plugin did not verify. The pipeline still checks the store's own directory.
    projectDir: explicit ? explicitDir : '',
    checked,
  }
}

/** Backwards-compatible alias: the name the earlier releases exported. */
export const discoverMemVault = discoverVault

const discovered = discoverVault()

/** Directory whose `.env` the extractor/embedder resolve against (may be empty). */
export const MEMVAULT_DIR = discovered.projectDir

/** Whether the paths came from the environment or from discovery, plus the search. */
export function discoverySnapshot() {
  return {
    source: discovered.source,
    found: discovered.found,
    projectDir: discovered.projectDir,
    candidates: discovered.checked,
  }
}

/** Turn endings that count as a finished turn by default. */
export const DEFAULT_END_REASONS = ['completed', 'max-tokens']

/**
 * Every knob, with its type, default and user-facing description.
 *
 * `role: 'slider'` and `step` are UI hints Schemastery's metadata carries; a
 * projection that does not know them ignores them.
 */
export const CONFIG_SPEC = {
  enabled: {
    kind: 'boolean',
    default: true,
    description: 'Inject the core blocks into the system prompt. Off injects the empty string forever.',
  },
  name: {
    kind: 'string',
    default: 'memvault:core',
    description: 'Name of the runtime-context contribution, as the trajectory lists it.',
  },
  order: {
    kind: 'number',
    integer: true,
    default: 210,
    description: 'Order among runtime-context contributions (skill-catalog and friends).',
  },
  scopes: {
    kind: 'array',
    default: DEFAULT_SCOPES,
    description: 'Core blocks are keyed by (scope_type, scope_id); both halves must be listed explicitly. '
      + 'These scopes are also the write scope: the first user scope becomes user_id, the first agent scope agent_id.',
    of: {
      kind: 'object',
      fields: {
        type: { kind: 'enum', values: ['user', 'agent'], default: 'user', description: 'Scope family.' },
        id: { kind: 'string', default: '', description: 'Scope id, e.g. lenovo.' },
      },
    },
  },
  labels: {
    kind: 'array',
    default: [],
    description: 'Only inject these labels. Empty means every block in the scopes.',
    of: { kind: 'string' },
  },
  maxChars: {
    kind: 'number',
    integer: true,
    min: 200,
    step: 100,
    role: 'slider',
    default: 4000,
    description: 'Budget for the whole rendered injection, header included.',
  },
  refreshMs: {
    kind: 'number',
    integer: true,
    min: 0,
    step: 1000,
    role: 'slider',
    default: 30_000,
    description: 'TTL of the cached render. The system prompt is the KV-cache prefix, so this is a cache knob.',
  },
  panel: {
    kind: 'object',
    default: {},
    description: 'The browser half (conversation tab + Plugins settings page).',
    fields: {
      writes: {
        kind: 'boolean',
        default: true,
        description: 'Let the panel create, replace and delete core blocks. Off makes it read-only (the route answers 403).',
      },
    },
  },
  extract: {
    kind: 'object',
    default: {},
    description: 'The write half: finished turns are windowed, then handed to MemVault as one conversation.',
    fields: {
      enabled: {
        kind: 'boolean',
        default: true,
        description: 'Off makes the plugin read-only: no window, no CLI call, panel flush answers 405.',
      },
      everyNTurns: {
        kind: 'number',
        integer: true,
        min: 1,
        default: 3,
        description: 'Turns that must accumulate before an extraction is considered.',
      },
      maxPendingSessions: {
        kind: 'number',
        integer: true,
        min: 0,
        default: 40,
        description: 'Sessions allowed to wait in the window at once. The oldest are dropped past this, so one busy day cannot grow it without bound. 0 disables the cap.',
      },
      maxPendingAgeMs: {
        kind: 'number',
        integer: true,
        min: 0,
        step: 60_000,
        role: 'slider',
        default: 21_600_000,
        description: 'How long a session may wait for its next turn before it is dropped. Measured from when it was last touched, not from the turns themselves. 0 disables the cap.',
      },
      idleMs: {
        kind: 'number',
        integer: true,
        min: 0,
        step: 1000,
        role: 'slider',
        default: 20_000,
        description: 'Quiet time after the last finished turn that hands the window over. A new turn re-arms it.',
      },
      windowTurns: {
        kind: 'number',
        integer: true,
        min: 1,
        default: 8,
        description: 'Hard cap: reaching this many turns extracts immediately, so a session that never pauses still gets extracted.',
      },
      endReasons: {
        kind: 'array',
        default: DEFAULT_END_REASONS,
        description: 'Which turn/end reasons count. aborted / error / interrupted / blocked are skipped by default; max-tokens is not.',
        of: { kind: 'string' },
      },
      includeAssistant: {
        kind: 'boolean',
        default: false,
        description: 'Ship the assistant prose too. Off by default: the extractor does not separate roles and stored the model’s own words as facts.',
      },
      includeTools: {
        kind: 'boolean',
        default: false,
        description: 'Ship tool calls and results too. Off by default: they eat the budget and carry little user signal.',
      },
      maxInputChars: {
        kind: 'number',
        integer: true,
        min: 200,
        // Schemastery's `step` is measured from `min`, not from zero: with
        // min 200 a step of 500 would reject the default 6000.
        step: 100,
        role: 'slider',
        default: 6000,
        description: 'Transcript budget per extraction; the newest lines win.',
      },
      minTranscriptChars: {
        kind: 'number',
        integer: true,
        min: 0,
        default: 40,
        description: 'Below this a window is not worth a process plus an LLM call; it is skipped and the watermark still advances.',
      },
      timeoutMs: {
        kind: 'number',
        integer: true,
        min: 1000,
        default: 60_000,
        description: 'Deadline of one extraction model request, in milliseconds. '
          + 'Applied as MEMVAULT_EXTRACT_TIMEOUT_MS unless the env map sets it explicitly.',
      },
      projectDir: {
        kind: 'string',
        default: MEMVAULT_DIR,
        description: 'Directory whose .env supplies the extractor, embedding endpoint and model overrides. '
          + 'No process is spawned: an empty value falls back to the .env next to the store.',
      },
      env: {
        kind: 'dict',
        default: {},
        description: 'Extra environment for this plugin: MEMVAULT_EXTRACTOR, MEMVAULT_EMBEDDER, '
          + 'MEMVAULT_EXTRACT_TIMEOUT_MS, API keys. Empty means "use the .env".',
      },
      statePath: {
        kind: 'string',
        default: DEFAULT_STATE_PATH,
        description: 'Watermarks, the last few diagnostics, and the not-yet-extracted windows.',
      },
    },
  },
}

/** The default for one spec node: leaves return their default, objects recurse. */
function defaultsOf(node) {
  if (node.kind === 'object') {
    const out = {}
    for (const [key, field] of Object.entries(node.fields ?? {})) out[key] = defaultsOf(field)
    return out
  }
  if (node.kind === 'array' && node.of?.kind === 'object') {
    return Array.isArray(node.default) ? node.default.map((item) => ({ ...item })) : []
  }
  if (node.default === undefined) return node.kind === 'array' ? [] : undefined
  return typeof node.default === 'object' && node.default !== null ? structuredClone(node.default) : node.default
}

/**
 * Every default, resolved.
 *
 * @returns the same shape as the config, fully populated.
 */
export function configDefaults(spec = CONFIG_SPEC) {
  return defaultsOf({ kind: 'object', fields: spec })
}

const coerceScalar = (node, value) => {
  if (node.kind === 'number') {
    if (typeof value === 'number') return { value }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return { value: Number(value), note: 'coerced from string' }
    }
    return { problem: `expected a number, got ${typeof value}` }
  }
  if (node.kind === 'boolean') {
    if (typeof value === 'boolean') return { value }
    return { problem: `expected a boolean, got ${typeof value}` }
  }
  if (node.kind === 'string') {
    if (value === null) return { value: null }
    if (typeof value === 'string') return { value }
    return { problem: `expected a string, got ${typeof value}` }
  }
  if (node.kind === 'enum') {
    if (node.values.includes(value)) return { value }
    return { problem: `expected one of ${node.values.join(' | ')}, got ${JSON.stringify(value)}` }
  }
  return { value }
}

/**
 * Merge a raw config over the defaults, report what does not belong, and coerce
 * what is merely written differently.
 *
 * Deliberately lenient: DSH validates the config against the schema before the
 * plugin runs (`Config`), so this is about (a) giving the code concrete values
 * without a dependency on Schemastery, and (b) telling the user what was ignored.
 * It never throws — a bad config should be visible in the panel, not fatal.
 *
 * @returns `{ config, unknown, problems }`.
 */
export function resolveConfig(raw = {}, spec = CONFIG_SPEC) {
  const unknown = []
  const problems = []

  const walk = (node, value, path) => {
    if (node.kind === 'object') {
      const out = {}
      const source = value === undefined || value === null ? {} : value
      if (typeof source !== 'object' || Array.isArray(source)) {
        problems.push(`${path || '<root>'} expected an object`)
        return defaultsOf(node)
      }
      for (const [key, child] of Object.entries(node.fields ?? {})) {
        out[key] = walk(child, source[key], path ? `${path}.${key}` : key)
      }
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(node.fields ?? {}, key)) unknown.push(path ? `${path}.${key}` : key)
      }
      return out
    }
    if (node.kind === 'array') {
      if (value === undefined || value === null) return defaultsOf(node)
      if (!Array.isArray(value)) {
        problems.push(`${path} expected an array`)
        return defaultsOf(node)
      }
      return value.map((item, index) => (node.of ? walk(node.of, item, `${path}[${index}]`) : item))
    }
    if (value === undefined) return defaultsOf(node)
    // `null` means "not set" for every kind: the default stands.
    if (value === null) return defaultsOf(node)
    if (node.kind === 'dict') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${path} expected an object of strings`)
        return defaultsOf(node)
      }
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') out[key] = item
        else problems.push(`${path}.${key} expected a string`)
      }
      return out
    }
    const result = coerceScalar(node, value)
    if (result.problem) {
      problems.push(`${path} ${result.problem}`)
      return defaultsOf(node)
    }
    if (result.note) problems.push(`${path} ${result.note}`)
    return result.value
  }

  return { config: walk({ kind: 'object', fields: spec }, raw, ''), unknown, problems }
}
