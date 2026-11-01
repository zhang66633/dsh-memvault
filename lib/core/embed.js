/**
 * Embedders: the offline default and an OpenAI-compatible endpoint.
 *
 * Both are **async** on purpose. A network embedder is asynchronous by nature,
 * and giving the offline one the same interface keeps every caller honest
 * instead of special-casing "this embedder never waits" — the kind of branch
 * that silently stops working the day a real model is configured.
 *
 * `LocalEmbedder` is deterministic feature hashing ported from the Python
 * engine (lowercase ascii words + single CJK chars + CJK bigrams, signed md5,
 * normalised). No model, no network: it is what makes the plugin work on first
 * install. `OpenAIEmbedder` is the upgrade, stored as a second `model` row so
 * switching models never rewrites a memory.
 */
import { createHash } from 'node:crypto'

const ASCII_WORD = /[a-z0-9_]+/g
const CJK_CHAR = /[\u4e00-\u9fff]/g

/** Lowercase ascii words + single CJK chars + CJK bigrams. */
export function tokenize(text) {
  const lowered = String(text ?? '').toLowerCase()
  const words = lowered.match(ASCII_WORD) || []
  const cjk = lowered.match(CJK_CHAR) || []
  const bigrams = []
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1])
  return [...words, ...cjk, ...bigrams]
}

function unit(vector) {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  return vector
}

export class LocalEmbedder {
  constructor(dim = 384) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error('dim must be a positive integer')
    this.dim = dim
    this.model = `local/${dim}`
    this.id = 'local'
  }

  async embed(texts) {
    return texts.map((text) => this.embedOneSync(text))
  }

  async embedOne(text) {
    return this.embedOneSync(text)
  }

  embedOneSync(text) {
    const vector = new Float32Array(this.dim)
    for (const token of tokenize(text)) {
      const digest = createHash('md5').update(token, 'utf8').digest()
      const index = digest.readUInt32BE(0) % this.dim
      vector[index] += (digest[4] & 1) ? 1 : -1
    }
    return unit(vector)
  }
}

export class OpenAIEmbedder {
  constructor({
    baseUrl = 'https://api.openai.com/v1',
    apiKey,
    model = 'text-embedding-3-small',
    timeoutMs = 30_000,
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey) throw new Error('apiKey is required')
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.apiKey = apiKey
    this.name = model
    this.model = `openai/${model}`
    this.dim = null
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.id = 'openai'
  }

  /** Embed a batch; returns one Float32Array per input, in input order. */
  async embed(texts) {
    if (!texts.length) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.name, input: texts }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`)
      const data = await response.json()
      const items = [...(data?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const vectors = items.map((item) => unit(Float32Array.from(item.embedding)))
      this.dim = vectors[0]?.length ?? this.dim
      return vectors
    } finally {
      clearTimeout(timer)
    }
  }

  async embedOne(text) {
    const [vector] = await this.embed([text])
    return vector
  }
}

/** Cosine similarity of two normalised vectors. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}
