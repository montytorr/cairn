import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const KEY_PREFIX = 'sk_live_'

/**
 * Generates a key and returns the plaintext alongside what gets stored.
 * The plaintext is shown to the user exactly once, at creation, and never
 * persisted — only its SHA-256 and a short display prefix are.
 */
export const generateApiKey = () => {
  const secret = randomBytes(32).toString('base64url')
  const key = `${KEY_PREFIX}${secret}`
  return {
    key,
    keyHash: hashApiKey(key),
    // Enough to recognise a key in a list, far too little to use one.
    keyPrefix: key.slice(0, KEY_PREFIX.length + 6),
  }
}

export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex')

/**
 * Constant-time comparison of two hex digests. Lookup is by hash equality in
 * Postgres, so this guards the final confirmation step against timing
 * analysis rather than the index probe.
 */
export const hashesMatch = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

export const looksLikeApiKey = (value: string): boolean =>
  value.startsWith(KEY_PREFIX) && value.length > KEY_PREFIX.length + 20
