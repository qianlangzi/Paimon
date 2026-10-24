import { Context } from '@deepseek-ai/cordis'
import type { Run, Task, TaskEvent } from '@deepseek-ai/dsh-paimon-task-runtime'
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

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()?.()
})

function mount(overrides: { listTasks?: () => readonly Task[]; taskDetail?: (id: string, limit?: number) => unknown } = {}) {
  const ctx = new Context()
  const fake = {
    listTasks: overrides.listTasks ?? (() => [openTask, waitingTask, finishedTask]),
    taskDetail: overrides.taskDetail ?? vi.fn(() => ({ task: openTask, runs: [run], events })),
  }
  ctx.provide('paimonTasks', fake as never)
  disposals.push(async () => { await ctx.fiber.dispose() })
  return { ctx, fake, controller: new PaimonTaskController(ctx) }
}

describe('task rows', () => {
  it('sorts by most recent activity, not by creation', () => {
    const { controller } = mount()
    expect(controller.list().map(row => row.id)).toEqual(['task-2', 'task-1', 'task-3'])
  })

  it('carries the approval flag so the inbox and the list agree', () => {
    const { controller } = mount()
    const rows = controller.list()
    expect(rows.find(row => row.id === 'task-2')?.needsApproval).toBe(true)
    expect(rows.find(row => row.id === 'task-1')?.needsApproval).toBe(false)
  })

  it('counts attempts from the runs a task started', () => {
    const { controller } = mount()
    expect(controller.list().find(row => row.id === 'task-2')?.attempt).toBe(2)
  })

  it('omits the outcome until the task is terminal', () => {
    const { controller } = mount()
    const rows = controller.list()
    expect(rows.find(row => row.id === 'task-1')?.outcome).toBeUndefined()
    expect(rows.find(row => row.id === 'task-3')?.outcome).toBe('succeeded')
  })

  it('does not leak domain fields a view cannot use', () => {
    const { controller } = mount()
    const row = controller.list()[0] as unknown as Record<string, unknown>
    for (const internal of ['currentRunId', 'runIds', 'finalResult', 'startedAt', 'cancelRequestedAt']) {
      expect(row[internal], internal).toBeUndefined()
    }
  })
})

describe('task detail', () => {
  it('passes the event window through to the adapter', () => {
    const { controller, fake } = mount()
    controller.detail('task-1', 15)
    expect(fake.taskDetail).toHaveBeenCalledWith('task-1', 15)
  })

  it('defaults to a bounded window rather than the whole log', () => {
    const { controller, fake } = mount()
    controller.detail('task-1')
    const limit = (fake.taskDetail as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]
    expect(typeof limit).toBe('number')
  })

  it('maps runs into the attempt shape, keeping the failure class but not the message', () => {
    const { controller } = mount()
    const first = controller.detail('task-1').runs[0]
    expect(first).toMatchObject({ attempt: 1, status: 'FAILED', errorKind: 'tool', timedOut: false })
    expect(JSON.stringify(first)).not.toContain('the tool failed')
  })

  it('shows the report of a still-running attempt instead of nothing', () => {
    // A task that has been probed but is not done still has a report; the
    // detail view is more useful showing it than showing a blank panel.
    const { controller } = mount()
    const detail = controller.detail('task-1')
    expect(detail.validation?.satisfied).toBe(false)
    expect(detail.validation?.checks[0]).toMatchObject({ id: 'tests', outcome: 'not-checked' })
  })

  it('prefers the final report once the task has one', () => {
    const { controller } = mount({
      taskDetail: () => ({ task: finishedTask, runs: [run], events: [] }),
    })
    expect(controller.detail('task-3').validation?.satisfied).toBe(true)
    expect(controller.detail('task-3').validation?.checks[0]?.description).toBe('unit tests pass')
  })

  it('propagates an unknown task instead of inventing an empty one', () => {
    const { controller } = mount({
      taskDetail: () => { throw new Error('task missing not found') },
    })
    expect(() => controller.detail('missing')).toThrow(/missing/)
  })
})
