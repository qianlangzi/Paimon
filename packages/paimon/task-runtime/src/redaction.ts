/** Marker written in place of a redacted value. */
export const REDACTED = '[REDACTED]'

/**
 * Field names whose values are treated as secrets.
 *
 * Matched against the *key*, not the value, because a value pattern alone
 * cannot distinguish a key from ordinary prose. The key is split into words
 * first, so `accessToken`, `access_token` and `ACCESS_TOKEN` all reach the same
 * decision — a plain substring match missed the camelCase spellings that JSON
 * payloads actually use, which is precisely where a leaked token arrives from.
 */
const SECRET_WORDS = new Set([
  'apikey',
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'credentialsfile',
  'sessionid',
])

/** Two-word combinations that name a secret without either word doing so. */
const SECRET_PAIRS = new Set(['api|key', 'session|id', 'private|key'])

/** Guards against pathological or cyclic structures during traversal. */
const MAX_DEPTH = 12

/**
 * Returns a structurally-cloned value with secret fields replaced by
 * {@link REDACTED} and known secret strings scrubbed from free text.
 *
 * `knownSecrets` covers the case where a secret leaked into a message, a
 * command line or a tool result rather than into a field named like one. Callers
 * pass the secrets they can enumerate (configured API keys, tokens they just
 * used); this function never tries to guess.
 *
 * Traversal stops at `MAX_DEPTH` and on cycles, returning a placeholder instead
 * of throwing, because redaction runs on the logging path and must never be the
 * reason a task dies.
 */
export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = knownSecrets.filter(secret => secret.length > 0)
  return walk(value, secrets, 0, new WeakSet<object>())
}

/** Convenience wrapper that redacts a record's values but keeps its keys. */
export function redactRecord(
  record: Readonly<Record<string, unknown>>,
  knownSecrets: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    output[key] = isSecretKey(key) ? REDACTED : redact(entry, knownSecrets)
  }
  return output
}

/** Whether a field name denotes a secret. */
export function isSecretKey(key: string): boolean {
  const words = wordsOf(key)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) continue
    if (SECRET_WORDS.has(word)) return true
    const next = words[index + 1]
    if (next !== undefined && SECRET_PAIRS.has(`${word}|${next}`)) return true
  }
  return false
}

/**
 * Splits a key into lowercase words on separators and camel humps.
 *
 * `accessToken` -> `['access', 'token']`, `API_KEY` -> `['api', 'key']`.
 */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(word => word.toLowerCase())
    .filter(word => word.length > 0)
}

/** Replaces every occurrence of a known secret inside free text. */
export function scrubText(text: string, knownSecrets: readonly string[]): string {
  let output = text
  for (const secret of knownSecrets) {
    if (secret.length === 0) continue
    output = output.split(secret).join(REDACTED)
  }
  return output
}

function walk(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return scrubText(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'
  // `seen` holds the objects on the *current* path, not every object ever
  // visited: the same sub-object appearing twice in a payload is a shared
  // reference, not a cycle, and calling it one would hide the second value.
  if (seen.has(value)) return '[CYCLE]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => walk(item, secrets, depth + 1, seen))
    }

    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key) ? REDACTED : walk(entry, secrets, depth + 1, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}
