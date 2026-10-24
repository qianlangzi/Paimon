/**
 * Argument keys that conventionally carry a filesystem path.
 *
 * Declared rather than inferred. A tool that names its path argument something
 * else simply gets no boundary check until the key is added here, which is the
 * honest failure mode: the adapter never guesses that an arbitrary string is a
 * path and never silently treats a path as unchecked without saying so.
 */
export const DEFAULT_PATH_ARGUMENT_KEYS: readonly string[] = [
  'path',
  'file_path',
  'filePath',
  'target',
]

/**
 * Returns the first argument that looks like a filesystem path.
 *
 * Only a non-empty string under a declared key qualifies. Numbers, nested
 * objects and arrays are ignored instead of stringified, because coercing them
 * would invent a path the caller never supplied and then check the boundary
 * against a fiction.
 */
export function extractPathArgument(
  args: unknown,
  keys: readonly string[] = DEFAULT_PATH_ARGUMENT_KEYS,
): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}
