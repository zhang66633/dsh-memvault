/**
 * The extraction pipeline on the in-plugin store (replaces the Python CLI call).
 *
 * Same contract as `runExtraction` in `lib/extract.js` — `{ ok, added, produced }`
 * and never throwing into the caller, because memory capture is a side channel
 * that must not break a turn. What changes is the implementation: extraction,
 * decisions and writes all happen in-process against `CoreStore`.
 *
 * The extractor is chosen from the merged environment, exactly like the Python
 * engine did: `MEMVAULT_EXTRACTOR` wins when set (`llm` needs a key, `rule`
 * forces the deterministic path), otherwise a key selects the LLM extractor and
 * its absence falls back to rules. No key is an install state, not an error.
 */
import { ChatClient } from './llm.js'
import { LLMExtractor, RuleExtractor } from './extract.js'
import { resolveEmbedder, findEnvFile, readEnvFile } from './env.js'
import { shapeProduced } from '../extract.js'
import { remember } from './write.js'

/**
 * Build the extractor + embedder for this install.
 *
 * @param {object} options
 * @param {string} [options.projectDir] - where the MemVault `.env` lives.
 * @param {string} [options.dbPath] - core store path (used for `.env` fallback).
 * @param {object} [options.env] - explicit environment (config, tests).
 */
export function buildPipeline({ projectDir = '', dbPath = '', env = process.env } = {}) {
  const file = findEnvFile({ projectDir, dbPath })
  const merged = { ...(file ? readEnvFile(file) : {}), ...env }
  let extraBody = {}
  if (merged.MEMVAULT_LLM_EXTRA_BODY) {
    try {
      extraBody = JSON.parse(merged.MEMVAULT_LLM_EXTRA_BODY)
    } catch {
      extraBody = {}
    }
  }
  const requested = String(merged.MEMVAULT_EXTRACTOR ?? '').toLowerCase()
  const useLlm = requested === 'rule' ? false : Boolean(merged.OPENAI_API_KEY)
  const extractor = useLlm
    ? new LLMExtractor(new ChatClient({
      baseUrl: merged.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: merged.OPENAI_API_KEY,
      model: merged.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      timeoutMs: Number(merged.MEMVAULT_EXTRACT_TIMEOUT_MS ?? 60_000),
      extraBody,
    }))
    : new RuleExtractor()
  return {
    extractor,
    embedder: resolveEmbedder({ projectDir, dbPath, env: merged }),
    usesModel: useLlm,
  }
}

/**
 * Run one extraction window against the core store.
 *
 * @returns {Promise<{ok: boolean, added?: number, superseded?: number,
 *   produced?: Array, error?: string}>}
 */
export async function runCoreExtraction({ store, extractor, embedder = null, scope = {}, messages }) {
  try {
    const summary = await remember({ store, scope, messages, extractor, embedder, origin: 'extract' })
    const produced = shapeProduced(summary.applied.map((memory) => ({
      id: memory.id,
      memory: memory.text,
      memory_type: memory.type,
    })))
    return {
      ok: true,
      added: summary.added + summary.superseded,
      superseded: summary.superseded,
      relations: summary.relations,
      produced,
    }
  } catch (error) {
    return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` }
  }
}
