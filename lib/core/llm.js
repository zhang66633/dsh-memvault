/**
 * The smallest OpenAI-compatible chat client the core needs.
 *
 * Extraction and decisions both speak Chat Completions; one client keeps the
 * timeout, auth header and error shape in one place. `fetchImpl` is injectable so
 * tests never touch the network, and a timeout aborts instead of hanging a turn
 * — the old engine's 60s extraction timeouts are the lesson behind that.
 */

export class ChatClient {
  constructor({
    baseUrl = 'https://api.openai.com/v1',
    apiKey = '',
    model = 'gpt-4o-mini',
    timeoutMs = 60_000,
    extraBody = {},
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey) throw new Error('apiKey is required')
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutMs
    this.extraBody = { ...extraBody }
    this.fetchImpl = fetchImpl
  }

  /** One chat completion; returns the assistant's text. */
  async complete(messages, { temperature = 0 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ ...this.extraBody, model: this.model, temperature, messages }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`chat HTTP ${response.status}`)
      const data = await response.json()
      return data?.choices?.[0]?.message?.content ?? ''
    } finally {
      clearTimeout(timer)
    }
  }
}
