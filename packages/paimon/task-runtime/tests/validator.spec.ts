import { describe, expect, it } from 'vitest'
import {
  ResultValidator,
  authoritativeOnly,
  commandExitRule,
  customRule,
  isAuthoritative,
  testReportRule,
} from '../src/index.ts'
import type { Evidence } from '../src/index.ts'

const passingReport: Evidence = {
  id: 'e-test-pass',
  kind: 'test-report',
  ref: 'suite:unit',
  passed: true,
  detail: '42 passed',
}

const failingReport: Evidence = {
  id: 'e-test-fail',
  kind: 'test-report',
  ref: 'suite:unit',
  passed: false,
  detail: '41 passed, 1 failed',
}

const modelClaim: Evidence = {
  id: 'e-claim',
  kind: 'model-claim',
  ref: 'assistant',
  passed: true,
  detail: 'all tests pass',
}

describe('evidence authority', () => {
  it('treats a model claim as non-authoritative', () => {
    expect(isAuthoritative('model-claim')).toBe(false)
  })

  it('treats observed facts as authoritative', () => {
    expect(isAuthoritative('test-report')).toBe(true)
    expect(isAuthoritative('command-exit')).toBe(true)
    expect(isAuthoritative('tool-result')).toBe(true)
    expect(isAuthoritative('file-state')).toBe(true)
  })

  it('drops claims and keeps observation order', () => {
    expect(authoritativeOnly([modelClaim, passingReport]).map(item => item.id)).toEqual(['e-test-pass'])
  })
})

describe('result validator', () => {
  it('cannot be satisfied by a model claim alone', () => {
    const validator = new ResultValidator([testReportRule({ id: 'tests', description: 'unit tests pass' })])
    const report = validator.validate([modelClaim])
    expect(report.satisfied).toBe(false)
    expect(report.checks[0]?.outcome).toBe('not-checked')
  })

  it('fails when the model claims success but the test report failed', () => {
    const validator = new ResultValidator([testReportRule({ id: 'tests', description: 'unit tests pass' })])
    const report = validator.validate([modelClaim, failingReport])
    expect(report.satisfied).toBe(false)
    expect(report.checks[0]?.outcome).toBe('failed')
  })

  it('passes only when observed evidence passes', () => {
    const validator = new ResultValidator([testReportRule({ id: 'tests', description: 'unit tests pass' })])
    const report = validator.validate([modelClaim, passingReport])
    expect(report.satisfied).toBe(true)
    expect(report.checks[0]?.outcome).toBe('passed')
  })

  it('never reports success when no completion condition was configured', () => {
    const report = new ResultValidator([]).validate([passingReport])
    expect(report.satisfied).toBe(false)
    expect(report.checks).toEqual([])
  })

  it('requires every configured rule to pass', () => {
    const validator = new ResultValidator([
      testReportRule({ id: 'tests', description: 'unit tests pass' }),
      commandExitRule({ id: 'build', description: 'build succeeds', commandRef: 'cmd:pnpm build' }),
    ])
    const report = validator.validate([
      passingReport,
      { id: 'e-cmd', kind: 'command-exit', ref: 'cmd:pnpm build', passed: false, detail: 'exit 1' },
    ])
    expect(report.satisfied).toBe(false)
    expect(report.checks.map(check => check.outcome)).toEqual(['passed', 'failed'])
  })

  it('fails when any one of several test reports failed', () => {
    const validator = new ResultValidator([testReportRule({ id: 'tests', description: 'all suites pass' })])
    const report = validator.validate([passingReport, { ...failingReport, id: 'e-test-fail-2', ref: 'suite:e2e' }])
    expect(report.satisfied).toBe(false)
  })

  it('checks an expected non-zero exit code', () => {
    const validator = new ResultValidator([
      commandExitRule({ id: 'lint', description: 'lint reports findings', commandRef: 'cmd:lint', expectExitCode: 1 }),
    ])
    const report = validator.validate([
      { id: 'e-lint', kind: 'command-exit', ref: 'cmd:lint', passed: true, detail: 'exit 1' },
    ])
    expect(report.satisfied).toBe(true)
  })

  it('keeps a custom rule from seeing a model claim', () => {
    let seen: readonly Evidence[] = []
    const rule = customRule({
      id: 'custom',
      description: 'sees only observations',
      evaluate: (evidence) => {
        seen = evidence
        return evidence.length > 0 ? 'passed' : 'not-checked'
      },
    })
    new ResultValidator([rule]).validate([modelClaim])
    expect(seen).toEqual([])
  })
})
