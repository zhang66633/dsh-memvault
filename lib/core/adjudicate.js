/**
 * The semantic half of "can these memories answer the question?".
 *
 * `answerabilityGuard()` only understands hard demands (numbers, times, ports):
 * when the question asks for a value and no candidate carries one, it rejects.
 * Everything else — "which editor do I use?" against a memory that merely
 * mentions editors — needs a judgement, and this asks the model for it.
 *
 * Fail-open on purpose: a timeout, an HTTP error or an unreadable answer returns
 * `{ answerable: null }`, leaving the guard's verdict (usually "unknown") in
 * place. A memory tool that breaks because the adjudicator is down would be worse
 * than one that returns a merely plausible answer.
 */
import { ChatClient } from './llm.js'
import { findEnvFile, readEnvFile } from './env.js'

export const ADJUDICATOR_MAX_CANDIDATES = 5
export const ADJUDICATOR_SNIPPET_CHARS = 300

export const ADJUDICATOR_PROMPT = (
  '你在判断记忆库里的候选记忆能否回答用户的问题。只输出一个 JSON 对象：'
  + '{"answerable": true 或 false, "reason": "不超过 30 字的中文理由"}。\n'
  + '规则：候选只是提到相关主题、但没有给出问题要的具体事实 → false；'
  + '候选给出了回答问题所需的事实 → true；'
  + '问题要求数字、时间或路径而候选没有对应值 → false。'
)

/** Parse `{"answerable": bool, "reason": string}` out of a model answer, tolerantly. */
export function parseVerdict(content) {
  const text = String(content ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    if (typeof data?.answerable !== 'boolean') return null
    return {
      answerable: data.answerable,
      reason: typeof data.reason === 'string' ? data.reason.slice(0, 200) : null,
    }
  } catch {
    return null
  }
}

export class LLMAdjudicator {
  constructor(client, { prompt = ADJUDICATOR_PROMPT } = {}) {
    this.client = client
    this.prompt = prompt
  }

  /** @returns {Promise<{answerable: boolean|null, reason: string|null}>} — never throws. */
  async check(query, results = []) {
    const lines = results
      .slice(0, ADJUDICATOR_MAX_CANDIDATES)
      .map((row, index) => `[${index + 1}] ${String(row?.text ?? '').slice(0, ADJUDICATOR_SNIPPET_CHARS)}`)
    try {
      const content = await this.client.complete([
        { role: 'system', content: this.prompt },
        { role: 'user', content: `问题：${query}\n\n候选记忆：\n${lines.join('\n')}` },
      ])
      return parseVerdict(content) ?? { answerable: null, reason: 'adjudicator returned no verdict' }
    } catch (error) {
      return { answerable: null, reason: `adjudicator failed: ${error?.message ?? String(error)}` }
    }
  }
}

/**
 * Build an adjudicator from the same `.env` the rest of the pipeline reads.
 * Returns null when disabled (`MEMVAULT_ADJUDICATOR=off`) or when there is no key
 * to call a model with — in both cases retrieval simply keeps the guard's answer.
 */
export function resolveAdjudicator({ projectDir = '', dbPath = '', env = process.env, envFile = null } = {}) {
  const file = findEnvFile({ projectDir, dbPath, envFile })
  const merged = { ...(file ? readEnvFile(file) : {}), ...env }
  const requested = String(merged.MEMVAULT_ADJUDICATOR ?? '').toLowerCase()
  if (requested === 'off' || !merged.OPENAI_API_KEY) return null
  let extraBody = {}
  if (merged.MEMVAULT_LLM_EXTRA_BODY) {
    try {
      extraBody = JSON.parse(merged.MEMVAULT_LLM_EXTRA_BODY)
    } catch {
      extraBody = {}
    }
  }
  return new LLMAdjudicator(new ChatClient({
    baseUrl: merged.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: merged.OPENAI_API_KEY,
    model: merged.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    timeoutMs: Number(merged.MEMVAULT_ADJUDICATOR_TIMEOUT_MS ?? 10_000),
    extraBody,
  }))
}
