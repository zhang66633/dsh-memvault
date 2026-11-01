/**
 * Embedder selection: the same `.env` the Python engine read, so the in-plugin
 * core does not invent a second configuration source.
 *
 * Precedence mirrors the engine's `load_dotenv`: real environment variables win
 * over the file. A configured `OPENAI_API_KEY` selects the OpenAI-compatible
 * embedder (the endpoint MemVault already used); otherwise the offline hashing
 * embedder is the default, which keeps a fresh install working with no key.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LocalEmbedder, OpenAIEmbedder } from './embed.js'

/** Minimal dotenv reader: KEY=VALUE, comments, optional surrounding quotes. */
export function readEnvFile(path) {
  try {
    const out = {}
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals <= 0) continue
      const key = trimmed.slice(0, equals).trim()
      let value = trimmed.slice(equals + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** First existing `.env` among explicit path, project dir, store dir. */
export function findEnvFile({ projectDir = '', dbPath = '', envFile = null } = {}) {
  const candidates = [
    envFile,
    projectDir ? join(projectDir, '.env') : null,
    dbPath ? join(dirname(dbPath), '.env') : null,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Pick an embedder for this install.
 *
 * `model` is the row key in `memory_embeddings`, so a later switch keeps the old
 * vectors instead of invalidating them.
 */
export function resolveEmbedder({ projectDir = '', dbPath = '', env = process.env, envFile = null } = {}) {
  const file = findEnvFile({ projectDir, dbPath, envFile })
  const merged = { ...(file ? readEnvFile(file) : {}), ...env }
  const apiKey = merged.OPENAI_API_KEY || ''
  // An explicit MEMVAULT_EMBEDDER wins, so a test or a user can pin the offline
  // embedder even when a key happens to be present in the same environment.
  const requested = String(merged.MEMVAULT_EMBEDDER ?? '').toLowerCase()
  const wantsOpenAI = requested === 'openai' || (requested === '' && Boolean(apiKey))
  if (wantsOpenAI && apiKey) {
    return new OpenAIEmbedder({
      baseUrl: merged.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey,
      model: merged.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    })
  }
  return new LocalEmbedder(Number(merged.MEMVAULT_EMBEDDING_DIM) || 384)
}
