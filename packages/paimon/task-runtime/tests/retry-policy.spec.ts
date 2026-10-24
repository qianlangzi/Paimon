import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRY_POLICY, decideRetry, taskError } from '../src/index.ts'

const base = { attempt: 1, cancelled: false, deadlineExceeded: false }

describe('retry policy', () => {
  it('retries a retryable failure while budget remains', () => {
    const decision = decideRetry({ ...base, error: taskError('tool', 'boom') })
    expect(decision).toMatchObject({ kind: 'retry', nextAttempt: 2 })
  })

  it('stops once the attempt budget is spent', () => {
    const decision = decideRetry({
      ...base,
      attempt: DEFAULT_RETRY_POLICY.maxAttempts,
      error: taskError('tool', 'boom'),
    })
    expect(decision.kind).toBe('stop')
    if (decision.kind === 'stop') expect(decision.reason).toMatch(/budget exhausted/)
  })

  it('never retries a permission denial', () => {
    const decision = decideRetry({ ...base, error: taskError('permission', 'denied') })
    expect(decision.kind).toBe('stop')
    if (decision.kind === 'stop') expect(decision.reason).toMatch(/not retryable/)
  })

  it('never retries a validation failure', () => {
    const decision = decideRetry({ ...base, error: taskError('validation', 'tests failed') })
    expect(decision.kind).toBe('stop')
  })

  it('lets a cancellation override a retryable failure kind', () => {
    const decision = decideRetry({ ...base, error: taskError('tool', 'boom'), cancelled: true })
    expect(decision.kind).toBe('stop')
    if (decision.kind === 'stop') expect(decision.reason).toMatch(/cancelled/)
  })

  it('lets an exhausted deadline override a retryable failure kind', () => {
    const decision = decideRetry({ ...base, error: taskError('tool', 'boom'), deadlineExceeded: true })
    expect(decision.kind).toBe('stop')
    if (decision.kind === 'stop') expect(decision.reason).toMatch(/deadline/)
  })

  it('checks cancellation before the attempt budget so a stop cannot be masked', () => {
    const decision = decideRetry({
      attempt: DEFAULT_RETRY_POLICY.maxAttempts,
      cancelled: true,
      deadlineExceeded: false,
      error: taskError('tool', 'boom'),
    })
    expect(decision.kind).toBe('stop')
    if (decision.kind === 'stop') expect(decision.reason).toMatch(/cancelled/)
  })

  it('honours a task-specific policy over the default', () => {
    const decision = decideRetry({
      ...base,
      error: taskError('tool', 'boom'),
      policy: { maxAttempts: 1, retryableKinds: ['tool'] },
    })
    expect(decision.kind).toBe('stop')
  })

  it('refuses a policy that omits the failure kind even with budget left', () => {
    const decision = decideRetry({
      ...base,
      error: taskError('model', 'bad response'),
      policy: { maxAttempts: 5, retryableKinds: ['tool'] },
    })
    expect(decision.kind).toBe('stop')
  })
})
