import { describe, expect, it } from 'vitest'
import {
  ResultValidator,
  type Evidence,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import {
  COMPLETION_MODES,
  DEFAULT_COMPLETION_MODE,
  completionRules,
} from '../src/completion.ts'

const passingTest: Evidence = {
  id: 'e1',
  kind: 'test-report',
  ref: 'tool:run_tests',
  passed: true,
  detail: '42 passed',
}

const failingTest: Evidence = {
  id: 'e2',
  kind: 'test-report',
  ref: 'tool:run_tests',
  passed: false,
  detail: '1 failed',
}

const successfulTool: Evidence = {
  id: 'e3',
  kind: 'tool-result',
  ref: 'tool:read_file',
  passed: true,
  detail: 'read 40 lines',
}

const modelClaim: Evidence = {
  id: 'e4',
  kind: 'model-claim',
  ref: 'assistant',
  passed: true,
  detail: 'all done',
}

function validate(mode: 'tests' | 'tool-success', evidence: readonly Evidence[]) {
  return new ResultValidator(completionRules(mode)).validate(evidence)
}

describe('completion modes', () => {
  it('offers exactly two modes and defaults to the stricter one', () => {
    expect(COMPLETION_MODES).toEqual(['tests', 'tool-success'])
    expect(DEFAULT_COMPLETION_MODE).toBe('tests')
  })

  it('always produces at least one rule, so a task is never unverifiable', () => {
    for (const mode of COMPLETION_MODES) {
      expect(completionRules(mode).length).toBeGreaterThan(0)
    }
  })
})

describe('the tests mode', () => {
  it('passes on a passing test report', () => {
    expect(validate('tests', [passingTest]).satisfied).toBe(true)
  })

  it('fails on a failing test report', () => {
    expect(validate('tests', [failingTest]).satisfied).toBe(false)
  })

  it('is not satisfied by a successful tool call alone', () => {
    // Running something is not the same as the tests passing.
    expect(validate('tests', [successfulTool]).satisfied).toBe(false)
  })

  it('is not satisfied by the model saying it is done', () => {
    expect(validate('tests', [modelClaim]).satisfied).toBe(false)
  })
})

describe('the tool-success mode', () => {
  it('passes once some tool call succeeded', () => {
    expect(validate('tool-success', [successfulTool]).satisfied).toBe(true)
  })

  it('is not satisfied by a model claim', () => {
    expect(validate('tool-success', [modelClaim]).satisfied).toBe(false)
  })

  it('is not satisfied before anything has run', () => {
    expect(validate('tool-success', []).satisfied).toBe(false)
  })

  it('stays satisfied even if a later call failed', () => {
    // Deliberately weak: this mode only asks whether something worked, and is
    // offered as a fallback rather than a default.
    const failure: Evidence = { ...successfulTool, id: 'e5', passed: false }
    expect(validate('tool-success', [successfulTool, failure]).satisfied).toBe(true)
  })
})
