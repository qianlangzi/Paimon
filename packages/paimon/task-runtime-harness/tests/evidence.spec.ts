import { describe, expect, it } from 'vitest'
import { extractEvidence } from '../src/evidence.ts'

const ok = { isError: false } as const
const failed = { isError: true, error: { message: 'command exited with 1' } } as const

describe('evidence extraction', () => {
  it('always records a tool-result for a successful call', () => {
    const evidence = extractEvidence({ callId: 'c1', toolName: 'read_file', result: ok })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ kind: 'tool-result', ref: 'tool:read_file', passed: true })
  })

  it('records a failed tool call as failing evidence', () => {
    const evidence = extractEvidence({ callId: 'c1', toolName: 'read_file', result: failed })
    expect(evidence[0]).toMatchObject({ kind: 'tool-result', passed: false })
    expect(evidence[0]?.detail).toBe('command exited with 1')
  })

  it('emits a test-report only for a declared test tool', () => {
    const asTest = extractEvidence({
      callId: 'c1',
      toolName: 'run_tests',
      result: ok,
      testTools: ['run_tests'],
    })
    expect(asTest.map(item => item.kind)).toEqual(['tool-result', 'test-report'])

    const asOrdinary = extractEvidence({
      callId: 'c2',
      toolName: 'read_file',
      result: ok,
      testTools: ['run_tests'],
    })
    expect(asOrdinary.map(item => item.kind)).toEqual(['tool-result'])
  })

  it('does not guess a test report when no test tool is declared', () => {
    // The adapter will not read a test report out of arbitrary output; an
    // undeclared tool must produce nothing a test rule would accept.
    const evidence = extractEvidence({ callId: 'c1', toolName: 'bash', result: ok })
    expect(evidence.some(item => item.kind === 'test-report')).toBe(false)
  })

  it('reports a failing declared test tool as a failing test report', () => {
    const evidence = extractEvidence({
      callId: 'c1',
      toolName: 'run_tests',
      result: failed,
      testTools: ['run_tests'],
    })
    const report = evidence.find(item => item.kind === 'test-report')
    expect(report).toMatchObject({ passed: false })
  })

  it('never emits a model claim', () => {
    const evidence = extractEvidence({
      callId: 'c1',
      toolName: 'run_tests',
      result: ok,
      testTools: ['run_tests'],
    })
    expect(evidence.some(item => item.kind === 'model-claim')).toBe(false)
  })

  it('gives each call distinct evidence ids', () => {
    const first = extractEvidence({ callId: 'c1', toolName: 'bash', result: ok })
    const second = extractEvidence({ callId: 'c2', toolName: 'bash', result: ok })
    expect(first[0]?.id).not.toBe(second[0]?.id)
    expect(new Set([...first, ...second].map(item => item.id)).size).toBe(2)
  })

  it('describes a silent failure without inventing a cause', () => {
    const evidence = extractEvidence({ callId: 'c1', toolName: 'bash', result: { isError: true } })
    expect(evidence[0]?.detail).toBe('the tool reported an error')
  })
})
