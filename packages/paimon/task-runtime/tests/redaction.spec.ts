import { describe, expect, it } from 'vitest'
import { REDACTED, isSecretKey, redact, redactRecord, scrubText } from '../src/index.ts'

describe('redaction', () => {
  it('recognises secret-shaped field names', () => {
    for (const key of ['apiKey', 'api_key', 'API-KEY', 'token', 'secret', 'password', 'Authorization', 'credential']) {
      expect(isSecretKey(key), key).toBe(true)
    }
  })

  it('leaves ordinary field names alone', () => {
    for (const key of ['goal', 'workspace', 'toolId', 'path', 'summary']) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })

  it('replaces a secret field value without touching its siblings', () => {
    const output = redactRecord({ apiKey: 'sk-live-123', goal: 'fix the build' })
    expect(output.apiKey).toBe(REDACTED)
    expect(output.goal).toBe('fix the build')
  })

  it('redacts nested secrets in objects and arrays', () => {
    const output = redact({
      request: { headers: { authorization: 'Bearer abc' } },
      calls: [{ token: 't-1' }, { ok: true }],
    })
    expect(output).toEqual({
      request: { headers: { authorization: REDACTED } },
      calls: [{ token: REDACTED }, { ok: true }],
    })
  })

  it('scrubs a known secret that leaked into free text', () => {
    expect(scrubText('running with sk-live-123 now', ['sk-live-123'])).toBe(`running with ${REDACTED} now`)
  })

  it('scrubs known secrets inside nested strings', () => {
    const output = redact({ command: 'curl -H "x-key: sk-live-123"' }, ['sk-live-123'])
    expect(output).toEqual({ command: `curl -H "x-key: ${REDACTED}"` })
  })

  it('recognises camelCase spellings of secret names', () => {
    // JSON payloads arrive camelCased, and a substring match on the original
    // pattern missed exactly the spellings a leaked token actually uses.
    for (const key of ['accessToken', 'clientSecret', 'refresh_token', 'sessionId', 'privateKey']) {
      expect(isSecretKey(key), key).toBe(true)
    }
  })

  it('leaves a shared reference readable instead of calling it a cycle', () => {
    // One object in two slots is a shared reference, not a cycle; masking the
    // second copy would hide data for no safety gain.
    const shared = { name: 'same' }
    expect(redact({ first: shared, second: shared })).toEqual({
      first: { name: 'same' },
      second: { name: 'same' },
    })
  })

  it('does not throw on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    expect(() => redact(cyclic)).not.toThrow()
    expect(redact(cyclic)).toMatchObject({ name: 'root', self: '[CYCLE]' })
  })

  it('truncates rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 40; index += 1) deep = { child: deep }
    expect(() => redact(deep)).not.toThrow()
  })
})
