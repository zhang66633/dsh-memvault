/**
 * The default embedder: deterministic feature hashing, ported from the Python
 * engine so the two stores produce comparable vectors.
 *
 * Tokens are lowercase ASCII words, single CJK characters and CJK bigrams
 * (Chinese has no spaces, so bigrams are what give overlap a chance). Each token
 * hashes to a signed coordinate; the vector is normalised. No model, no network,
 * identical output on every run — which is exactly what a default must be when
 * the plugin promises to work offline on first install.
 *
 * It is also weak: it measures token overlap, not meaning. The design doc keeps
 * a real embedding endpoint as an optional upgrade, stored as a second `model`
 * row rather than a replacement.
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

export class LocalEmbedder {
  constructor(dim = 384) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error('dim must be a positive integer')
    this.dim = dim
    this.model = `local/${dim}`
  }

  embed(texts) {
    return texts.map((text) => this.embedOne(text))
  }

  embedOne(text) {
    const vector = new Float32Array(this.dim)
    for (const token of tokenize(text)) {
      const digest = createHash('md5').update(token, 'utf8').digest()
      const index = digest.readUInt32BE(0) % this.dim
      vector[index] += (digest[4] & 1) ? 1 : -1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
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
