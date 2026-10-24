import { describe, expect, it } from 'vitest'
import { approvalToResolved, toPreToolDecision } from '../src/mapping.ts'

describe('gate decision mapping', () => {
  it('passes an allow through unchanged', () => {
    expect(toPreToolDecision({ kind: 'allow' })).toEqual({ kind: 'allow' })
  })

  it('carries the denial reason to the model', () => {
    expect(toPreToolDecision({ kind: 'deny', reason: 'outside workspace' }))
      .toEqual({ kind: 'deny', reason: 'outside workspace' })
  })

  it('maps an approval request onto the ask decision', () => {
    expect(toPreToolDecision({ kind: 'require-approval', reason: 'needs a human' }))
      .toEqual({ kind: 'ask', reason: 'needs a human' })
  })

  it('maps cancellation onto the canonical cancel decision', () => {
    expect(toPreToolDecision({ kind: 'cancelled', reason: 'user asked' })).toEqual({ kind: 'cancel' })
  })

  it('refuses a timed-out call with an explanation rather than a bare cancel', () => {
    // A spent budget is a refusal the model should read, not "the caller
    // stopped this", which is what `cancel` means in the harness pipeline.
    const decision = toPreToolDecision({ kind: 'timed-out', reason: 'deadline passed' })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toBe('deadline passed')
  })

  it('never maps a refusal onto allow', () => {
    const refusals = [
      { kind: 'deny', reason: 'x' } as const,
      { kind: 'cancelled', reason: 'x' } as const,
      { kind: 'timed-out', reason: 'x' } as const,
    ]
    for (const refusal of refusals) {
      expect(toPreToolDecision(refusal).kind).not.toBe('allow')
    }
  })

  it('fails closed on an unrecognised decision instead of returning nothing', () => {
    // A typed caller cannot reach this; an untyped one must not slip past the
    // pipeline with `undefined`.
    const rogue = { kind: 'something-new' } as unknown as Parameters<typeof toPreToolDecision>[0]
    const decision = toPreToolDecision(rogue)
    expect(decision.kind).toBe('deny')
  })
})

describe('approval outcome mapping', () => {
  it('treats the single-use grant as consent', () => {
    expect(approvalToResolved('allowed-once')).toMatchObject({ approved: true })
  })

  it('treats an explicit rejection as refusal', () => {
    expect(approvalToResolved('rejected')).toMatchObject({ approved: false })
  })

  it('treats a withdrawn request as refusal, not consent', () => {
    expect(approvalToResolved('cancelled')).toMatchObject({ approved: false })
  })

  it('treats a missing answerer as refusal, not consent', () => {
    // The seam is fail-closed; "nobody could answer" must never read as yes.
    expect(approvalToResolved('unavailable')).toMatchObject({ approved: false })
  })

  it('grants on exactly one of the four outcomes', () => {
    const outcomes = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
    const granted = outcomes.filter(outcome => approvalToResolved(outcome).approved)
    expect(granted).toEqual(['allowed-once'])
  })
})
