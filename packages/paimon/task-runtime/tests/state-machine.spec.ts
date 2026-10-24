import { describe, expect, it } from 'vitest'
import {
  InvalidTransitionError,
  TASK_TERMINAL_STATUSES,
  assertTaskTransition,
  canTransitionTask,
  runTargets,
  taskTargets,
} from '../src/index.ts'
import type { TaskStatus } from '../src/index.ts'

describe('task state machine', () => {
  it('gives every terminal status an empty transition list', () => {
    for (const terminal of TASK_TERMINAL_STATUSES) {
      expect(taskTargets(terminal)).toEqual([])
    }
  })

  it('forbids the three transitions PRD 6.1 names explicitly', () => {
    expect(canTransitionTask('SUCCEEDED', 'RUNNING')).toBe(false)
    expect(canTransitionTask('CANCELLED', 'RUNNING')).toBe(false)
    expect(canTransitionTask('TIMED_OUT', 'SUCCEEDED')).toBe(false)
  })

  it('forbids every transition out of every terminal status', () => {
    const all: TaskStatus[] = ['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']
    for (const terminal of TASK_TERMINAL_STATUSES) {
      for (const target of all) {
        expect(canTransitionTask(terminal, target)).toBe(false)
      }
    }
  })

  it('never treats a status as its own successor', () => {
    const all: TaskStatus[] = ['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']
    for (const status of all) {
      expect(canTransitionTask(status, status)).toBe(false)
    }
  })

  it('lets a pending task start, fail, or be cancelled', () => {
    expect(canTransitionTask('PENDING', 'RUNNING')).toBe(true)
    expect(canTransitionTask('PENDING', 'FAILED')).toBe(true)
    expect(canTransitionTask('PENDING', 'CANCELLED')).toBe(true)
  })

  it('lets a running task reach every terminal status', () => {
    for (const terminal of TASK_TERMINAL_STATUSES) {
      expect(canTransitionTask('RUNNING', terminal)).toBe(true)
    }
  })

  it('requires an approval round trip to return through RUNNING, never straight to SUCCEEDED', () => {
    expect(canTransitionTask('WAITING_APPROVAL', 'RUNNING')).toBe(true)
    expect(canTransitionTask('WAITING_APPROVAL', 'SUCCEEDED')).toBe(false)
  })

  it('reports the illegal transition instead of silently ignoring it', () => {
    expect(() => assertTaskTransition('TIMED_OUT', 'SUCCEEDED')).toThrow(InvalidTransitionError)
    expect(() => assertTaskTransition('TIMED_OUT', 'SUCCEEDED')).toThrow(/TIMED_OUT -> SUCCEEDED/)
  })

  it('lets a run end exactly once', () => {
    expect(runTargets('RUNNING')).toEqual(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
    for (const terminal of TASK_TERMINAL_STATUSES) {
      expect(runTargets(terminal)).toEqual([])
    }
  })
})
