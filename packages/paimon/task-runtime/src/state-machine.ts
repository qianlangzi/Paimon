import { InvalidTransitionError } from './errors.ts'
import type { RunStatus, TaskStatus } from './types.ts'

/**
 * The complete task transition table.
 *
 * Design decisions worth defending:
 *
 * 1. Every terminal status maps to an empty list. `SUCCEEDED -> RUNNING`,
 *    `CANCELLED -> RUNNING` and `TIMED_OUT -> SUCCEEDED` are therefore
 *    structurally impossible rather than merely discouraged.
 * 2. `FAILED` is terminal at the task level. A failed *run* does not fail the
 *    task while retry budget remains; the task stays `RUNNING` and a new run is
 *    appended. The task only fails once the budget is exhausted, so a task
 *    never has to be resurrected to represent a retry.
 * 3. `WAITING_APPROVAL` returns to `RUNNING` on approval and never straight to
 *    a terminal success, so an approved operation still has to execute and be
 *    validated.
 * 4. A task may be cancelled from `PENDING` (nothing started yet) and from
 *    `WAITING_APPROVAL` (the user withdrew while a decision was pending).
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  WAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
}

/** A run is a single attempt: it starts running and ends exactly once. */
const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
}

/** Whether `from -> to` is a legal task transition. Same status is not a transition. */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

/** Whether `from -> to` is a legal run transition. */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/** Every status a task may move to from `from`, for reporting and UI hints. */
export function taskTargets(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from]
}

/** Every status a run may move to from `from`. */
export function runTargets(from: RunStatus): readonly RunStatus[] {
  return RUN_TRANSITIONS[from]
}

/** Asserts a legal task transition, throwing {@link InvalidTransitionError} otherwise. */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new InvalidTransitionError('task', from, to, `allowed targets: ${describe(TASK_TRANSITIONS[from])}`)
  }
}

/** Asserts a legal run transition, throwing {@link InvalidTransitionError} otherwise. */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidTransitionError('run', from, to, `allowed targets: ${describe(RUN_TRANSITIONS[from])}`)
  }
}

function describe(targets: readonly (TaskStatus | RunStatus)[]): string {
  return targets.length === 0 ? 'none (terminal)' : targets.join(', ')
}
