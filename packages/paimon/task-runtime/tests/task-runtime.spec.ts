import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ApprovalPendingError,
  TaskClosedError,
  TaskNotFoundError,
  TaskRuntime,
  createManualClock,
  taskError,
  testReportRule,
} from '../src/index.ts'
import type { Evidence } from '../src/index.ts'

const passingTests: Evidence = {
  id: 'e-tests',
  kind: 'test-report',
  ref: 'suite:unit',
  passed: true,
  detail: '42 passed',
}

const failingTests: Evidence = {
  id: 'e-tests-fail',
  kind: 'test-report',
  ref: 'suite:unit',
  passed: false,
  detail: '1 failed',
}

const modelClaim: Evidence = {
  id: 'e-claim',
  kind: 'model-claim',
  ref: 'assistant',
  passed: true,
  detail: 'I fixed it, tests pass',
}

function harness(options: { readonly knownSecrets?: readonly string[] } = {}) {
  const clock = createManualClock(1_700_000_000_000)
  let counter = 0
  const runtime = new TaskRuntime({
    clock,
    idFactory: () => `id-${(counter += 1)}`,
    knownSecrets: options.knownSecrets,
  })
  return { runtime, clock }
}

const rule = testReportRule({ id: 'tests', description: 'unit tests pass' })

describe('task runtime: happy path', () => {
  it('runs a task to a verified success', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'fix the build', workspace: resolve('/tmp/ws'), rules: [rule] })
    expect(task.status).toBe('PENDING')

    const run = runtime.startRun(task.id)
    expect(run.attempt).toBe(1)
    expect(runtime.getTask(task.id).status).toBe('RUNNING')

    const outcome = runtime.completeRun(task.id, [passingTests], 'tests green')
    expect(outcome.kind).toBe('succeeded')

    const settled = runtime.getTask(task.id)
    expect(settled.status).toBe('SUCCEEDED')
    expect(settled.finalResult?.outcome).toBe('succeeded')
    expect(settled.finalResult?.validation?.satisfied).toBe(true)
    expect(settled.finalResult?.runId).toBe(run.id)
  })

  it('records a queryable timeline for the task', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'fix the build', rules: [rule] })
    runtime.startRun(task.id)
    runtime.completeRun(task.id, [passingTests], 'done')

    const types = runtime.getEvents(task.id).map(event => event.type)
    expect(types).toEqual(expect.arrayContaining([
      'task/created',
      'task/status-changed',
      'run/started',
      'validation/completed',
    ]))
    expect(types.at(-1)).toBe('task/status-changed')
  })
})

describe('task runtime: completion cannot be claimed', () => {
  it('fails when the model claims success but the tests failed', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'fix the build', rules: [rule] })
    runtime.startRun(task.id)

    const outcome = runtime.completeRun(task.id, [modelClaim, failingTests], 'I believe it works')
    expect(outcome.kind).toBe('failed')
    expect(runtime.getTask(task.id).status).toBe('FAILED')
    expect(runtime.getTask(task.id).finalResult?.validation?.satisfied).toBe(false)
  })

  it('never succeeds a task that declares no completion condition', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'do something vague' })
    runtime.startRun(task.id)

    const outcome = runtime.completeRun(task.id, [passingTests], 'trust me')
    expect(outcome.kind).toBe('failed')
    expect(runtime.getTask(task.id).status).toBe('FAILED')
  })
})

describe('task runtime: bounded retry', () => {
  it('appends runs until the attempt budget is spent', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'flaky work' })

    runtime.startRun(task.id)
    const first = runtime.failRun(task.id, taskError('tool', 'transient failure'))
    expect(first.retried).toBe(true)
    expect(first.task.status).toBe('RUNNING')
    expect(first.task.currentRunId).toBeUndefined()

    runtime.startRun(task.id)
    const second = runtime.failRun(task.id, taskError('tool', 'transient failure'))
    expect(second.retried).toBe(true)

    runtime.startRun(task.id)
    const third = runtime.failRun(task.id, taskError('tool', 'transient failure'))
    expect(third.retried).toBe(false)
    expect(third.task.status).toBe('FAILED')
    expect(third.reason).toMatch(/budget exhausted/)

    const runs = runtime.listRuns(task.id)
    expect(runs).toHaveLength(3)
    expect(runs.map(run => run.attempt)).toEqual([1, 2, 3])
    expect(runs.every(run => run.status === 'FAILED')).toBe(true)
  })

  it('does not retry a permission denial', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'touch a protected file' })
    runtime.startRun(task.id)

    const outcome = runtime.failRun(task.id, taskError('permission', 'denied by policy'))
    expect(outcome.retried).toBe(false)
    expect(outcome.task.status).toBe('FAILED')
  })

  it('honours a task-level retry policy', () => {
    const { runtime } = harness()
    const task = runtime.createTask({
      goal: 'single attempt only',
      retryPolicy: { maxAttempts: 1, retryableKinds: ['tool'] },
    })
    runtime.startRun(task.id)
    const outcome = runtime.failRun(task.id, taskError('tool', 'boom'))
    expect(outcome.retried).toBe(false)
  })
})

describe('task runtime: cancellation', () => {
  it('distinguishes a cancel request from a stopped execution', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'long job' })
    runtime.startRun(task.id)

    runtime.requestCancel(task.id)
    const requested = runtime.getTask(task.id)
    expect(requested.cancelRequestedAt).toBeDefined()
    expect(requested.status).toBe('RUNNING')
    expect(requested.cancelAcknowledgedAt).toBeUndefined()

    const stopped = runtime.acknowledgeCancel(task.id)
    expect(stopped.status).toBe('CANCELLED')
    expect(stopped.cancelAcknowledgedAt).toBeDefined()
    expect(runtime.listRuns(task.id)[0]?.status).toBe('CANCELLED')
  })

  it('refuses new tool calls once a cancel is requested', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'long job' })
    runtime.startRun(task.id)
    runtime.requestCancel(task.id)

    expect(runtime.gateToolCall(task.id, { toolId: 'bash' }).kind).toBe('cancelled')
  })

  it('never retries after a cancel request', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'long job' })
    runtime.startRun(task.id)
    runtime.requestCancel(task.id)

    const outcome = runtime.failRun(task.id, taskError('tool', 'interrupted'))
    expect(outcome.retried).toBe(false)
    expect(outcome.task.status).toBe('CANCELLED')
  })

  it('is idempotent and does not touch a finished task', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'quick job', rules: [rule] })
    runtime.startRun(task.id)
    runtime.completeRun(task.id, [passingTests], 'done')

    const before = runtime.getEvents(task.id).length
    runtime.requestCancel(task.id)
    expect(runtime.getEvents(task.id)).toHaveLength(before)
    expect(runtime.getTask(task.id).status).toBe('SUCCEEDED')
  })

  it('rejects acknowledging a cancellation that was never requested', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job' })
    expect(() => runtime.acknowledgeCancel(task.id)).toThrow(/no pending cancellation/)
  })
})

describe('task runtime: deadline', () => {
  it('closes the task as TIMED_OUT once the budget is spent', () => {
    const { runtime, clock } = harness()
    const task = runtime.createTask({ goal: 'slow job', deadlineMs: 1_000 })
    runtime.startRun(task.id)

    clock.advance(1_500)
    expect(runtime.enforceDeadline(task.id)).toBe(true)

    const settled = runtime.getTask(task.id)
    expect(settled.status).toBe('TIMED_OUT')
    expect(settled.finalResult?.outcome).toBe('timed-out')
    expect(runtime.listRuns(task.id)[0]?.status).toBe('TIMED_OUT')
  })

  it('stops tool calls after the deadline even without an explicit sweep', () => {
    const { runtime, clock } = harness()
    const task = runtime.createTask({ goal: 'slow job', deadlineMs: 1_000 })
    runtime.startRun(task.id)
    clock.advance(1_500)

    expect(runtime.gateToolCall(task.id, { toolId: 'bash' }).kind).toBe('timed-out')
    expect(runtime.getTask(task.id).status).toBe('TIMED_OUT')
  })

  it('refuses to start a run with no budget left', () => {
    const { runtime, clock } = harness()
    const task = runtime.createTask({ goal: 'slow job', deadlineMs: 1_000 })
    runtime.startRun(task.id)
    clock.advance(2_000)

    expect(() => runtime.startRun(task.id)).toThrow(TaskClosedError)
  })

  it('leaves an unbudgeted task untouched', () => {
    const { runtime, clock } = harness()
    const task = runtime.createTask({ goal: 'no deadline' })
    runtime.startRun(task.id)
    clock.advance(10_000_000)
    expect(runtime.enforceDeadline(task.id)).toBe(false)
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })
})

describe('task runtime: workspace boundary', () => {
  it('allows paths inside the workspace and denies escapes', () => {
    const { runtime } = harness()
    const workspace = resolve('/tmp/paimon-ws')
    const task = runtime.createTask({ goal: 'edit code', workspace })
    runtime.startRun(task.id)

    expect(runtime.gateToolCall(task.id, { toolId: 'fs_read', path: resolve(workspace, 'src/a.ts') }).kind)
      .toBe('allow')
    expect(runtime.gateToolCall(task.id, { toolId: 'fs_read', path: resolve('/etc/passwd') }).kind)
      .toBe('deny')
  })

  it('denies any path when the task declares no workspace', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'edit code' })
    runtime.startRun(task.id)
    expect(runtime.gateToolCall(task.id, { toolId: 'fs_read', path: resolve('/tmp/a.ts') }).kind).toBe('deny')
  })

  it('records the denial instead of failing silently', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'edit code', workspace: resolve('/tmp/paimon-ws') })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, { toolId: 'fs_read', path: resolve('/etc/passwd') })

    const denied = runtime.getEvents(task.id).filter(event => event.type === 'tool/denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]?.data.reason).toMatch(/outside the task workspace/)
  })
})

describe('task runtime: approval', () => {
  it('parks the task while a decision is pending and resumes on rejection', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'delete a directory' })
    runtime.startRun(task.id)

    const gate = runtime.gateToolCall(task.id, { toolId: 'rm', requiresApproval: true })
    expect(gate.kind).toBe('require-approval')
    expect(runtime.getTask(task.id).status).toBe('WAITING_APPROVAL')

    const decision = runtime.resolveApproval(task.id, false, 'too risky')
    expect(decision.kind).toBe('deny')
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })

  it('resumes execution when approved', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'delete a directory' })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, { toolId: 'rm', requiresApproval: true })

    expect(runtime.resolveApproval(task.id, true).kind).toBe('allow')
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })

  it('refuses to start a run while an approval is pending', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'delete a directory' })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, { toolId: 'rm', requiresApproval: true })

    expect(() => runtime.startRun(task.id)).toThrow(/waiting for an approval/)
  })
})

describe('task runtime: log hygiene', () => {
  it('redacts secret fields and scrubs known secrets from recorded events', () => {
    const { runtime } = harness({ knownSecrets: ['sk-live-999'] })
    const task = runtime.createTask({ goal: 'call an api' })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, {
      toolId: 'http',
      detail: { apiKey: 'sk-live-999', url: 'https://example.test?key=sk-live-999' },
    })

    const requested = runtime.getEvents(task.id).find(event => event.type === 'tool/requested')
    expect(requested?.data.apiKey).toBe('[REDACTED]')
    expect(requested?.data.url).toBe('https://example.test?key=[REDACTED]')
  })
})

describe('task runtime: guards', () => {
  it('rejects unknown task ids', () => {
    const { runtime } = harness()
    expect(() => runtime.getTask('nope')).toThrow(TaskNotFoundError)
  })

  it('rejects settling a run twice', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)
    runtime.completeRun(task.id, [passingTests], 'done')
    expect(() => runtime.completeRun(task.id, [passingTests], 'again')).toThrow(/no active run/)
  })

  it('rejects starting a second concurrent run', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job' })
    runtime.startRun(task.id)
    expect(() => runtime.startRun(task.id)).toThrow(/already has an active run/)
  })

  it('rejects resolving an approval that was never requested', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job' })
    runtime.startRun(task.id)
    expect(() => runtime.resolveApproval(task.id, true)).toThrow(/not WAITING_APPROVAL/)
  })

  it('refuses to settle a run while an approval is still pending', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, { toolId: 'rm', requiresApproval: true })

    // Settling now would have to invent the approval outcome. It refuses with
    // a named error instead of silently withdrawing the pending decision.
    expect(() => runtime.completeRun(task.id, [passingTests], 'done')).toThrow(ApprovalPendingError)
    expect(() => runtime.failRun(task.id, taskError('tool', 'boom'))).toThrow(ApprovalPendingError)
    expect(runtime.getTask(task.id).status).toBe('WAITING_APPROVAL')
  })

  it('settles normally once the pending approval is resolved', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)
    runtime.gateToolCall(task.id, { toolId: 'rm', requiresApproval: true })
    runtime.resolveApproval(task.id, true)

    expect(runtime.completeRun(task.id, [passingTests], 'done').kind).toBe('succeeded')
  })
})

describe('task runtime: completion probing', () => {
  it('reports a failing condition without closing the run', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)

    const report = runtime.checkCompletion(task.id, [failingTests])
    expect(report.satisfied).toBe(false)
    // Probing must not settle: a model that checks too early keeps working.
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
    expect(runtime.getTask(task.id).currentRunId).toBeDefined()
  })

  it('reports a passing condition without settling either', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)

    expect(runtime.checkCompletion(task.id, [passingTests]).satisfied).toBe(true)
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })

  it('agrees with the settlement that follows it', () => {
    const { runtime } = harness()
    const task = runtime.createTask({ goal: 'job', rules: [rule] })
    runtime.startRun(task.id)

    expect(runtime.checkCompletion(task.id, [passingTests]).satisfied).toBe(true)
    expect(runtime.completeRun(task.id, [passingTests], 'done').kind).toBe('succeeded')
  })
})
