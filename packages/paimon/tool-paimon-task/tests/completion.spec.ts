import { describe, expect, it } from 'vitest'
import {
  ResultValidator,
  type Evidence,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import {
  COMPLETION_MODES,
  DEFAULT_COMPLETION_MODE,
  completionRules,
  completionRuleSpecs,
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

function validate(mode: 'auto' | 'tests' | 'tool-success', evidence: readonly Evidence[], hasTestTools = true) {
  return new ResultValidator(completionRules(mode, { hasTestTools })).validate(evidence)
}

describe('completion modes', () => {
  it('offers auto plus the two explicit policies, and defaults to auto', () => {
    expect(COMPLETION_MODES).toEqual(['auto', 'tests', 'tool-success'])
    expect(DEFAULT_COMPLETION_MODE).toBe('auto')
  })

  it('always produces at least one rule, so a task is never unverifiable', () => {
    for (const mode of COMPLETION_MODES) {
      expect(completionRules(mode, { hasTestTools: true }).length).toBeGreaterThan(0)
      expect(completionRules(mode, { hasTestTools: false }).length).toBeGreaterThan(0)
    }
  })
})

describe('the auto mode', () => {
  it('verifies against tests when the deployment declares a test runner', () => {
    expect(completionRuleSpecs('auto', { hasTestTools: true }).map(spec => spec.kind)).toEqual(['test-report'])
    expect(validate('auto', [passingTest]).satisfied).toBe(true)
  })

  it('falls back to tool success when no test runner is declared', () => {
    // The shipped profile declares no test tool, so `tests` could never be
    // satisfied there: the old default silently made every task unfinishable.
    expect(completionRuleSpecs('auto', { hasTestTools: false }).map(spec => spec.kind)).toEqual(['any-tool-success'])
    expect(validate('auto', [successfulTool], false).satisfied).toBe(true)
    expect(validate('auto', [passingTest], false).satisfied).toBe(false)
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
