import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManualClock,
  TaskRuntime,
  testReportRule,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import type { Run, Task, TaskEvent } from '@deepseek-ai/dsh-paimon-task-runtime'
import { EVENTS_FILE, FileTaskStore } from '../src/index.ts'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'paimon-store-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

const task: Task = {
  id: 'task-1',
  goal: 'fix the build',
  status: 'RUNNING',
  workspace: '/repo/project',
  deadlineMs: 60_000,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:01.000Z',
  startedAt: '2026-10-24T00:00:01.000Z',
  cancelRequestedAt: undefined,
  cancelAcknowledgedAt: undefined,
  currentRunId: 'run-1',
  runIds: ['run-1'],
  finalResult: undefined,
}

const run: Run = {
  id: 'run-1',
  taskId: 'task-1',
  attempt: 1,
  status: 'RUNNING',
  startedAt: '2026-10-24T00:00:01.000Z',
  endedAt: undefined,
  error: undefined,
  resultSummary: undefined,
  timedOut: false,
}

const event: TaskEvent = {
  id: 'event-1',
  taskId: 'task-1',
  runId: 'run-1',
  type: 'task/created',
  timestamp: '2026-10-24T00:00:00.000Z',
  data: { goal: 'fix the build' },
}

describe('file store: durability', () => {
  it('creates its directory when missing', () => {
    const directory = join(temporaryDirectory(), 'nested', 'tasks')
    const store = new FileTaskStore({ directory })
    expect(store.location).toBe(directory)
    expect(store.listTasks()).toEqual([])
  })

  it('restores tasks, runs and events in a second instance', () => {
    const directory = temporaryDirectory()
    const first = new FileTaskStore({ directory })
    first.saveTask(task)
    first.saveRun(run)
    first.appendEvent(event)

    const second = new FileTaskStore({ directory })
    expect(second.getTask('task-1')).toMatchObject({ goal: 'fix the build', status: 'RUNNING' })
    expect(second.getRun('run-1')).toMatchObject({ attempt: 1, taskId: 'task-1' })
    expect(second.listEvents({ taskId: 'task-1' })).toHaveLength(1)
  })

  it('keeps the event log append-only across instances', () => {
    const directory = temporaryDirectory()
    const first = new FileTaskStore({ directory })
    first.appendEvent(event)

    const second = new FileTaskStore({ directory })
    second.appendEvent({ ...event, id: 'event-2', type: 'run/started' })

    const third = new FileTaskStore({ directory })
    expect(third.listEvents().map(item => item.id)).toEqual(['event-1', 'event-2'])
  })

  it('leaves no temporary files behind', () => {
    const directory = temporaryDirectory()
    const store = new FileTaskStore({ directory })
    store.saveTask(task)
    store.saveRun(run)
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('file store: queries', () => {
  it('orders tasks by creation time', () => {
    const store = new FileTaskStore({ directory: temporaryDirectory() })
    store.saveTask({ ...task, id: 'later', createdAt: '2026-10-24T02:00:00.000Z' })
    store.saveTask({ ...task, id: 'earlier', createdAt: '2026-10-24T01:00:00.000Z' })
    expect(store.listTasks().map(item => item.id)).toEqual(['earlier', 'later'])
  })

  it('orders runs by attempt and scopes them to their task', () => {
    const store = new FileTaskStore({ directory: temporaryDirectory() })
    store.saveRun({ ...run, id: 'a3', attempt: 3 })
    store.saveRun({ ...run, id: 'a1', attempt: 1 })
    store.saveRun({ ...run, id: 'other', taskId: 'task-2', attempt: 1 })
    expect(store.listRuns('task-1').map(item => item.id)).toEqual(['a1', 'a3'])
  })

  it('filters events by task, run and type', () => {
    const store = new FileTaskStore({ directory: temporaryDirectory() })
    store.appendEvent(event)
    store.appendEvent({ ...event, id: 'e2', type: 'run/started' })
    store.appendEvent({ ...event, id: 'e3', taskId: 'task-2' })

    expect(store.listEvents({ taskId: 'task-1' })).toHaveLength(2)
    expect(store.listEvents({ type: 'run/started' })).toHaveLength(1)
    expect(store.listEvents({ taskId: 'task-1', runId: 'run-1' })).toHaveLength(2)
    expect(store.listEvents({ taskId: 'task-2' })).toHaveLength(1)
  })
})

describe('file store: damaged input', () => {
  it('discards a torn final line left by a crash mid-append', () => {
    const directory = temporaryDirectory()
    const path = join(directory, EVENTS_FILE)
    writeFileSync(path, `${JSON.stringify(event)}\n{"id":"cut-of`, 'utf8')

    const store = new FileTaskStore({ directory })
    expect(store.listEvents().map(item => item.id)).toEqual(['event-1'])
  })

  it('refuses to start when a non-final line is unparseable', () => {
    const directory = temporaryDirectory()
    const path = join(directory, EVENTS_FILE)
    writeFileSync(path, `{"broken\n${JSON.stringify(event)}\n`, 'utf8')

    // History is the point of this file; skipping a bad middle line would
    // silently lose facts, so the store reports it instead.
    expect(() => new FileTaskStore({ directory })).toThrow(/line 1 is not a valid event/)
  })

  it('rejects a snapshot written by a different layout version', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, 'tasks.json'), JSON.stringify({ version: 99, items: {} }), 'utf8')
    expect(() => new FileTaskStore({ directory })).toThrow(/declares version 99/)
  })
})

describe('file store: end-to-end with the runtime', () => {
  it('restores a finished task and its timeline after a restart', () => {
    const directory = temporaryDirectory()
    const rule = testReportRule({ id: 'tests', description: 'tests pass' })

    const first = new TaskRuntime({
      store: new FileTaskStore({ directory }),
      clock: createManualClock(1_700_000_000_000),
      idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
    })
    const created = first.createTask({ goal: 'fix the build', workspace: '/repo/project', rules: [rule] })
    first.startRun(created.id)
    first.completeRun(created.id, [
      { id: 'e1', kind: 'test-report', ref: 'tool:run_tests', passed: true, detail: '42 passed' },
    ], 'tests green')

    // A new runtime over the same directory stands in for a restarted process.
    const second = new TaskRuntime({
      store: new FileTaskStore({ directory }),
      clock: createManualClock(1_700_000_000_000),
    })
    const restored = second.getTask(created.id)
    expect(restored.status).toBe('SUCCEEDED')
    expect(restored.finalResult?.outcome).toBe('succeeded')
    expect(second.listRuns(created.id)).toHaveLength(1)
    expect(second.getEvents(created.id).map(item => item.type)).toEqual(
      expect.arrayContaining(['task/created', 'run/started', 'validation/completed']),
    )
    expect(readFileSync(join(directory, EVENTS_FILE), 'utf8').trim().split('\n').length)
      .toBe(second.getEvents(created.id).length)
  })
})
