/** Marker written in place of a redacted value. */
export const REDACTED = '[REDACTED]'

/**
 * Field names whose values are treated as secrets.
 *
 * Matched case-insensitively against the *key*, not the value, because a value
 * pattern alone cannot distinguish a key from ordinary prose.
 */
const SECRET_KEY_PATTERN =
  /(?:^|[^a-z])(?:api[-_]?key|apikey|secret|token|password|passwd|credential|authorization|cookie|session[-_]?id)(?:$|[^a-z])/i

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
  return SECRET_KEY_PATTERN.test(key)
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
  if (seen.has(value)) return '[CYCLE]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map(item => walk(item, secrets, depth + 1, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? REDACTED : walk(entry, secrets, depth + 1, seen)
  }
  return output
}
