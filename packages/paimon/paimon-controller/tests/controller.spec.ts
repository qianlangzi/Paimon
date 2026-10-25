import { Context } from '@deepseek-ai/cordis'
import type { RetryPolicy, Run, Task, TaskEvent } from '@deepseek-ai/dsh-paimon-task-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaimonTaskController } from '../src/index.ts'

/**
 * The controller is deliberately thin, so the tests focus on the two things it
 * actually decides: the shape handed to a view, and the order of the list. The
 * governance layer's own spec owns everything else.
 */

const openTask: Task = {
  id: 'task-1',
  goal: 'fix the failing test',
  status: 'RUNNING',
  workspace: '/repo/project',
  deadlineMs: 60_000,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:05.000Z',
  startedAt: '2026-10-24T10:00:01.000Z',
  cancelRequestedAt: undefined,
  cancelAcknowledgedAt: undefined,
  currentRunId: 'run-1',
  runIds: ['run-1'],
  finalResult: undefined,
}

const waitingTask: Task = {
  ...openTask,
  id: 'task-2',
  goal: 'delete the temp directory',
  status: 'WAITING_APPROVAL',
  updatedAt: '2026-10-24T10:05:00.000Z',
  currentRunId: 'run-2',
  runIds: ['run-1', 'run-2'],
}

const finishedTask: Task = {
  ...openTask,
  id: 'task-3',
  goal: 'already done',
  status: 'SUCCEEDED',
  updatedAt: '2026-10-24T09:00:00.000Z',
  currentRunId: undefined,
  finalResult: {
    outcome: 'succeeded',
    summary: 'tests green',
    runId: 'run-1',
    validation: {
      satisfied: true,
      checks: [{ id: 'tests', description: 'unit tests pass', outcome: 'passed', evidence: ['e1'], note: undefined }],
    },
  },
}

const run: Run = {
  id: 'run-1',
  taskId: 'task-1',
  attempt: 1,
  status: 'FAILED',
  startedAt: '2026-10-24T10:00:01.000Z',
  endedAt: '2026-10-24T10:00:05.000Z',
  error: { kind: 'tool', message: 'the tool failed', detail: 'exit 1' },
  resultSummary: 'first attempt',
  timedOut: false,
}

const events: TaskEvent[] = [
  { id: 'e1', taskId: 'task-1', runId: undefined, type: 'task/created', timestamp: '2026-10-24T10:00:00.000Z', data: { goal: 'fix the failing test' } },
  { id: 'e2', taskId: 'task-1', runId: 'run-1', type: 'validation/completed', timestamp: '2026-10-24T10:00:04.000Z', data: { satisfied: false, checks: [{ id: 'tests', outcome: 'not-checked', note: 'no test report was collected' }] } },
]

/** The resolved policy the adapter reports; the projection copies it verbatim. */
const policy: RetryPolicy = { maxAttempts: 3, retryableKinds: ['model', 'tool', 'internal'] }

/** A timeline entry that carries nothing but its position, for window tests. */
function filler(index: number): TaskEvent {
  return {
    id: `f${index}`,
    taskId: 'task-1',
    runId: 'run-1',
    type: 'tool/executed',
    timestamp: `2026-10-24T10:01:${String(index % 60).padStart(2, '0')}.000Z`,
    data: { index },
  }
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()?.()
})

function mount(overrides: { listTasks?: () => readonly Task[]; taskDetail?: (id: string, limit?: number) => unknown } = {}) {
  const ctx = new Context()
  const base = overrides.taskDetail ?? (() => ({ task: openTask, runs: [run], events }))
  const fake = {
    listTasks: overrides.listTasks ?? (() => [openTask, waitingTask, finishedTask]),
    // Every detail carries the resolved policy; a case that cares about the
    // policy states its own and wins over this default.
    taskDetail: vi.fn((id: string, limit?: number) => ({ retryPolicy: policy, ...base(id, limit) as object })),
  }
  ctx.provide('paimonTasks', fake as never)
  disposals.push(async () => { await ctx.fiber.dispose() })
  return { ctx, fake, controller: new PaimonTaskController(ctx) }
}

describe('task rows', () => {
  it('sorts by most recent activity, not by creation', async () => {
    const { controller } = mount()
    expect((await controller.list()).map(row => row.id)).toEqual(['task-2', 'task-1', 'task-3'])
  })

  it('carries the approval flag so the inbox and the list agree', async () => {
    const { controller } = mount()
    const rows = await controller.list()
    expect(rows.find(row => row.id === 'task-2')?.needsApproval).toBe(true)
    expect(rows.find(row => row.id === 'task-1')?.needsApproval).toBe(false)
  })

  it('counts attempts from the runs a task started', async () => {
    const { controller } = mount()
    expect((await controller.list()).find(row => row.id === 'task-2')?.attempt).toBe(2)
  })

  it('omits the outcome until the task is terminal', async () => {
    const { controller } = mount()
    const rows = await controller.list()
    expect(rows.find(row => row.id === 'task-1')?.outcome).toBeUndefined()
    expect(rows.find(row => row.id === 'task-3')?.outcome).toBe('succeeded')
  })

  it('does not leak domain fields a view cannot use', async () => {
    const { controller } = mount()
    const row = (await controller.list())[0] as unknown as Record<string, unknown>
    for (const internal of ['currentRunId', 'runIds', 'finalResult', 'startedAt', 'cancelRequestedAt']) {
      expect(row[internal], internal).toBeUndefined()
    }
  })
})

describe('task detail', () => {
  it('applies the event window to the payload, not to the read', async () => {
    // The read has to stay whole: the validation report is rebuilt from the
    // timeline, so a truncated read would silently drop the checks of any task
    // whose last probe fell outside the window.
    const { controller, fake } = mount()
    const detail = await controller.detail('task-1', 1)
    expect(fake.taskDetail).toHaveBeenCalledWith('task-1')
    expect(detail.events.map(event => event.type)).toEqual(['validation/completed'])
    expect(detail.validation?.checks).toHaveLength(1)
  })

  it('defaults to a bounded window rather than the whole log', async () => {
    const { controller } = mount({
      taskDetail: () => ({
        task: openTask,
        runs: [run],
        events: Array.from({ length: 500 }, (_, index) => filler(index)),
      }),
    })
    const detail = await controller.detail('task-1')
    expect(detail.events.length).toBe(200)
  })

  it('reads a zero-length window as "no events" rather than "no limit"', async () => {
    const { controller } = mount()
    expect((await controller.detail('task-1', 0)).events).toEqual([])
  })

  it('keeps the report of a task whose probe is older than the window', async () => {
    // The regression this guards: the window used to be applied to the read, so
    // a retried task lost its checks the moment the timeline outgrew the window.
    const noise: TaskEvent[] = Array.from({ length: 50 }, (_, index) => filler(index))
    const { controller } = mount({
      taskDetail: () => ({ task: openTask, runs: [run], events: [...events, ...noise] }),
    })
    const detail = await controller.detail('task-1', 5)
    expect(detail.events).toHaveLength(5)
    expect(detail.events.some(event => event.type === 'validation/completed')).toBe(false)
    expect(detail.validation?.satisfied).toBe(false)
  })

  it('maps runs into the attempt shape, keeping the failure class but not the message', async () => {
    const { controller } = mount()
    const first = (await controller.detail('task-1')).runs[0]
    expect(first).toMatchObject({ attempt: 1, status: 'FAILED', errorKind: 'tool', timedOut: false })
    expect(JSON.stringify(first)).not.toContain('the tool failed')
  })

  it('shows the report of a still-running attempt instead of nothing', async () => {
    // A task that has been probed but is not done still has a report; the
    // detail view is more useful showing it than showing a blank panel.
    const { controller } = mount()
    const detail = await controller.detail('task-1')
    expect(detail.validation?.satisfied).toBe(false)
    expect(detail.validation?.checks[0]).toMatchObject({ id: 'tests', outcome: 'not-checked' })
  })

  it('prefers the final report once the task has one', async () => {
    const { controller } = mount({
      taskDetail: () => ({ task: finishedTask, runs: [run], events: [] }),
    })
    const detail = await controller.detail('task-3')
    expect(detail.validation?.satisfied).toBe(true)
    expect(detail.validation?.checks[0]?.description).toBe('unit tests pass')
  })

  it('flattens structured event data into JSON text for the wire', async () => {
    // The Remote boundary cannot carry unconstrained data, so a nested payload
    // travels as a string. A view that needs structure reads `validation`.
    const { controller } = mount()
    const detail = await controller.detail('task-1')
    const validationEvent = detail.events.find(event => event.type === 'validation/completed')
    expect(typeof validationEvent?.data.satisfied).toBe('boolean')
    expect(typeof validationEvent?.data.checks).toBe('string')
    expect(JSON.parse(validationEvent?.data.checks as string)).toEqual([
      { id: 'tests', outcome: 'not-checked', note: 'no test report was collected' },
    ])
  })

  it('propagates an unknown task instead of inventing an empty one', async () => {
    const { controller } = mount({
      taskDetail: () => { throw new Error('task missing not found') },
    })
    await expect(controller.detail('missing')).rejects.toThrow(/missing/)
  })
})

describe('diagnostics projection', () => {
  it('reports the resolved retry budget, not the task field that may be absent', async () => {
    // `openTask` carries no `retryPolicy`: it inherits the deployment default,
    // and the view must be able to say "3 attempts" rather than "unknown".
    const { controller } = mount()
    expect((await controller.detail('task-1')).retry).toEqual({
      maxAttempts: 3,
      retryableKinds: ['model', 'tool', 'internal'],
    })
  })

  it('turns a relative budget into the instant it expires', async () => {
    const { controller } = mount()
    const row = (await controller.list()).find(item => item.id === 'task-1')
    expect(row?.deadlineMs).toBe(60_000)
    expect(row?.deadlineAt).toBe('2026-10-24T10:01:01.000Z')
  })

  it('omits the expiry while a task has not started', async () => {
    const { controller } = mount({ listTasks: () => [{ ...openTask, startedAt: undefined }] })
    expect((await controller.list())[0]?.deadlineAt).toBeUndefined()
  })

  it('survives a task whose start timestamp does not parse', async () => {
    // The file store is hand-editable; one unreadable timestamp must not make
    // the whole list reject, which would blank every view at once.
    const { controller } = mount({ listTasks: () => [{ ...openTask, startedAt: 'not a timestamp' }] })
    expect((await controller.list())[0]?.deadlineAt).toBeUndefined()
  })

  it('joins the recorded retry verdict onto the attempt it belongs to', async () => {
    const ended: TaskEvent = {
      id: 'e3',
      taskId: 'task-1',
      runId: 'run-1',
      type: 'run/ended',
      timestamp: '2026-10-24T10:00:05.000Z',
      data: { attempt: 1, status: 'FAILED', retry: 'retry', reason: 'failure kind "tool" is retryable' },
    }
    const { controller } = mount({
      taskDetail: () => ({ task: openTask, runs: [run], events: [...events, ended], retryPolicy: policy }),
    })
    expect((await controller.detail('task-1')).runs[0]).toMatchObject({
      attempt: 1,
      retryDecision: 'retry',
      retryReason: 'failure kind "tool" is retryable',
    })
  })

  it('leaves the verdict absent for an attempt that is still running', async () => {
    const { controller } = mount()
    expect((await controller.detail('task-1')).runs[0]?.retryDecision).toBeUndefined()
  })
})
