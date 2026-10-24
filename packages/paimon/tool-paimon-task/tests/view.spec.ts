import { describe, expect, it } from 'vitest'
import {
  createManualClock,
  TaskRuntime,
  testReportRule,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import type { ValidationReport } from '@deepseek-ai/dsh-paimon-task-runtime'
import {
  renderReport,
  renderSummary,
  renderTimeline,
  reportSummary,
  taskSummary,
} from '../src/view.ts'

function newTask() {
  const runtime = new TaskRuntime({
    clock: createManualClock(1_700_000_000_000),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
  return { runtime, task: runtime.createTask({ goal: 'fix the build' }) }
}

describe('task summary projection', () => {
  it('reports the fields the model needs to act', () => {
    const { runtime, task } = newTask()
    const run = runtime.startRun(task.id)
    const summary = taskSummary(runtime.getTask(task.id), [run])

    expect(summary).toMatchObject({
      taskId: task.id,
      goal: 'fix the build',
      status: 'RUNNING',
      attempt: 1,
      cancelRequested: false,
    })
  })

  it('omits optional fields instead of emitting nulls', () => {
    const { runtime, task } = newTask()
    const summary = taskSummary(runtime.getTask(task.id), [])
    expect('workspace' in summary).toBe(false)
    expect('deadlineMs' in summary).toBe(false)
    expect('outcome' in summary).toBe(false)
  })

  it('includes workspace, deadline and outcome when present', () => {
    const runtime = new TaskRuntime({
      clock: createManualClock(1_700_000_000_000),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    })
    const task = runtime.createTask({
      goal: 'job',
      workspace: '/repo/project',
      deadlineMs: 5_000,
      rules: [testReportRule({ id: 'tests', description: 'tests pass' })],
    })
    runtime.startRun(task.id)
    runtime.completeRun(task.id, [
      { id: 'e1', kind: 'test-report', ref: 'tool:run_tests', passed: true, detail: 'ok' },
    ], 'done')

    const summary = taskSummary(runtime.getTask(task.id), runtime.listRuns(task.id))
    expect(summary).toMatchObject({
      status: 'SUCCEEDED',
      workspace: '/repo/project',
      deadlineMs: 5_000,
      outcome: 'succeeded',
    })
  })

  it('flags a pending cancellation', () => {
    const { runtime, task } = newTask()
    runtime.startRun(task.id)
    runtime.requestCancel(task.id)
    expect(taskSummary(runtime.getTask(task.id), []).cancelRequested).toBe(true)
  })
})

describe('report projection', () => {
  const report: ValidationReport = {
    satisfied: false,
    checks: [
      { id: 'tests', description: 'tests pass', outcome: 'failed', evidence: ['e1', 'e2'], note: '1 of 2 failed' },
      { id: 'build', description: 'build passes', outcome: 'not-checked', evidence: [], note: undefined },
    ],
  }

  it('drops evidence ids the model cannot use', () => {
    const summary = reportSummary(report)
    expect(JSON.stringify(summary)).not.toContain('e1')
    expect(summary.checks.map(check => check.id)).toEqual(['tests', 'build'])
  })

  it('keeps the reason a check failed', () => {
    expect(reportSummary(report).checks[0]?.note).toBe('1 of 2 failed')
  })

  it('omits a missing note rather than emitting undefined', () => {
    expect('note' in (reportSummary(report).checks[1] ?? {})).toBe(false)
  })
})

describe('report rendering', () => {
  it('states satisfaction plainly when every check passed', () => {
    const text = renderReport({
      satisfied: true,
      checks: [{ id: 'tests', outcome: 'passed' }],
    })
    expect(text).toMatch(/satisfied/i)
  })

  it('explains that an empty rule set can never verify', () => {
    const text = renderReport({ satisfied: false, checks: [] })
    expect(text).toMatch(/never be verified/i)
  })

  it('leads with the verdict and names each unmet condition', () => {
    const text = renderReport(reportSummary({
      satisfied: false,
      checks: [
        { id: 'tests', description: 'tests pass', outcome: 'failed', evidence: [], note: '1 of 2 failed' },
      ],
    }))
    expect(text.split('\n')[0]).toMatch(/NOT verified/)
    expect(text).toContain('tests: failed (1 of 2 failed)')
  })
})

describe('summary and timeline rendering', () => {
  it('renders a compact task header', () => {
    const text = renderSummary({
      taskId: 't1',
      goal: 'fix the build',
      status: 'RUNNING',
      attempt: 2,
      cancelRequested: false,
    })
    expect(text).toContain('task t1: RUNNING (attempt 2)')
    expect(text).toContain('goal: fix the build')
  })

  it('announces a requested cancellation and a final outcome', () => {
    const text = renderSummary({
      taskId: 't1',
      goal: 'g',
      status: 'FAILED',
      attempt: 3,
      cancelRequested: true,
      outcome: 'failed',
    })
    expect(text).toContain('cancellation has been requested')
    expect(text).toContain('outcome: failed')
  })

  it('says so when there is no history', () => {
    expect(renderTimeline([])).toBe('no events recorded')
  })

  it('renders events in arrival order', () => {
    const text = renderTimeline([
      { type: 'task/created', timestamp: 't0' },
      { type: 'run/started', timestamp: 't1' },
    ])
    expect(text.split('\n')).toEqual(['t0 task/created', 't1 run/started'])
  })
})
