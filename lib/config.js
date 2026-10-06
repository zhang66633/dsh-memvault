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
import { DEFAULT_DB_PATH, DEFAULT_SCOPES } from './blocks.js'
import { DEFAULT_STATE_PATH } from './extract.js'

/** This package's own root — used as one place to look for a sibling checkout. */
const DEFAULT_PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Find a MemVault checkout, so that "installed the plugin" and "set up MemVault"
 * do not have to be two pieces of configuration the user performs.
 *
 * Order matters and is deliberate:
 *
 * 1. `MEMVAULT_DIR` / `MEMVAULT_PYTHON` — an explicit answer always wins.
 * 2. the author's conventional location, then a few common ones (`~/memvault`,
 *    `~/projects/memvault`, a sibling of this plugin's own directory);
 * 3. nothing found — and then the panel says so instead of guessing silently.
 *
 * A candidate counts only if it has both the package (`memvault/__init__.py`) and a
 * venv interpreter; a directory with one but not the other is reported as the
 * reason, because "found the project but no venv" is a fixable, specific problem.
 */
export function discoverMemVault({ env = process.env, pluginDir = DEFAULT_PLUGIN_DIR } = {}) {
  const isFile = (path) => { try { return statSync(path).isFile() } catch { return false } }
  const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
  const join = (...parts) => parts.join('/').replace(/\/+/g, '/')

  const explicitDir = env.MEMVAULT_DIR
  const explicitPython = env.MEMVAULT_PYTHON
  const candidates = [
    explicitDir,
    'D:/Claude_code/memory',
    join(homedir(), 'memvault'),
    join(homedir(), 'projects', 'memvault'),
    join(pluginDir, '..', 'memory'),
  ].filter((dir) => typeof dir === 'string' && dir !== '')

  const venvOf = (dir) => (process.platform === 'win32'
    ? [`${dir}/.venv/Scripts/python.exe`, `${dir}/.venv/bin/python`]
    : [`${dir}/.venv/bin/python`, `${dir}/.venv/Scripts/python.exe`])

  const checked = []
  // An explicit answer wins even when it is wrong: silently substituting a working
  // directory for the one the user named is how "my memories are in the other
  // vault" happens. Report the failure instead — the panel shows it.
  const explicit = typeof explicitDir === 'string' && explicitDir !== ''
  for (const dir of [...new Set(candidates)]) {
    const hasPackage = isFile(`${dir}/memvault/__init__.py`)
    const python = venvOf(dir).find(isFile)
    checked.push({ dir, hasPackage, python: python ?? null })
    if (hasPackage && python) {
      return { found: true, source: dir === explicitDir ? 'env' : 'discovered', projectDir: dir, pythonPath: python, checked }
    }
    if (explicit) break
  }
  // Nothing usable: keep whatever the environment said, so the failure is visible
  // rather than silently replaced by a path that does not exist either.
  return {
    found: false,
    // Either env variable counts as "the user answered" — claiming `none` while a
    // wrong MEMVAULT_DIR is in force would be the panel telling a small lie.
    source: (explicit || explicitPython) ? 'env' : 'none',
    projectDir: explicitDir ?? candidates[1] ?? '',
    pythonPath: explicitPython ?? venvOf(explicitDir ?? candidates[1] ?? '')[0],
    checked,
  }
}

const discovered = discoverMemVault()

/** MemVault checkout the write half drives (discovered, or the explicit env). */
export const MEMVAULT_DIR = discovered.projectDir

/** Interpreter that can `import memvault` — the venv, not the system python. */
export const MEMVAULT_PYTHON = discovered.pythonPath

/** How the path was decided: `env`, `discovered`, or `none`. The panel shows it. */
export const MEMVAULT_SOURCE = discovered.source

/** Candidate directories that were looked at, for the setup card's explanation. */
export const MEMVAULT_CANDIDATES = discovered.checked

/**
 * The store path this plugin will use when nothing is configured.
 *
 * Derived from the *discovered* checkout rather than written down: MemVault's own
 * relative default is `data/memvault.db` inside its project directory, so a machine
 * whose MemVault lives somewhere else gets that somewhere else. `MEMVAULT_DB_PATH`
 * still wins when set - an explicit answer outranks a discovered one.
 */
export const MEMVAULT_DB_PATH_DEFAULT = process.env.MEMVAULT_DB_PATH
  ?? `${discovered.projectDir}/data/memvault.db`

/** Whether the paths came from the environment or from discovery, plus the search. */
export function discoverySnapshot() {
  return {
    source: discovered.source,
    found: discovered.found,
    projectDir: discovered.projectDir,
    pythonPath: discovered.pythonPath,
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
  dbPath: {
    kind: 'string',
    default: MEMVAULT_DB_PATH_DEFAULT,
    description: 'Path to memvault.db. Read-only; the MemVault service and MCP clients share this file.',
  },
  scopes: {
    kind: 'array',
    default: DEFAULT_SCOPES,
    description: 'Core blocks are keyed by (scope_type, scope_id); both halves must be listed explicitly.',
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
        default: 120_000,
        description: 'Timeout for one extraction; the child is killed and a single warning is recorded.',
      },
      pythonPath: {
        kind: 'string',
        default: MEMVAULT_PYTHON,
        description: 'Interpreter that can import memvault — the venv, not the system python.',
      },
      projectDir: {
        kind: 'string',
        default: MEMVAULT_DIR,
        description: 'Working directory of the child (the MemVault checkout, whose .env it loads).',
      },
      user: {
        kind: 'string',
        default: 'lenovo',
        description: 'user_id written with. The three scope axes are orthogonal; leave empty to omit the flag.',
      },
      agent: {
        kind: 'string',
        default: 'claude-code-memory',
        description: 'agent_id written with.',
      },
      run: {
        kind: 'string',
        default: '',
        description: 'run_id written with; an empty value omits the flag (the three scope axes are orthogonal).',
      },
      env: {
        kind: 'dict',
        default: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        description: 'Extra child environment. The UTF-8 pair is what keeps a Chinese Windows from mangling the transcript.',
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
