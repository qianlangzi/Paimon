import type { RunStatus, TaskError, TaskErrorKind, TaskStatus } from './types.ts'

/** Builds a structured error without losing the optional detail field. */
export function taskError(
  kind: TaskErrorKind,
  message: string,
  detail?: string,
): TaskError {
  return { kind, message, detail: detail ?? undefined }
}

/**
 * Raised when code asks for a status change the state machine forbids.
 *
 * This is a programming error, not a task failure: it means a caller tried to
 * rewrite history (for example `TIMED_OUT -> SUCCEEDED`). Throwing keeps the
 * illegal attempt visible instead of silently dropping it.
 */
export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: 'task' | 'run',
    readonly from: TaskStatus | RunStatus,
    readonly to: TaskStatus | RunStatus,
    readonly reason: string,
  ) {
    super(`illegal ${entity} transition ${from} -> ${to}: ${reason}`)
    this.name = 'InvalidTransitionError'
  }
}

/**
 * Raised when a task is asked to do work after it reached a terminal status.
 *
 * Callers should surface this to the user rather than retrying, because a
 * finished task is immutable by design.
 */
export class TaskClosedError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: TaskStatus,
  ) {
    super(`task ${taskId} is already ${status}`)
    this.name = 'TaskClosedError'
  }
}

/** Raised when a referenced task or run does not exist. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} does not exist`)
    this.name = 'TaskNotFoundError'
  }
}

/**
 * Raised when a run is settled while a human decision is still pending.
 *
 * PRD 5.2 pauses the execution flow at an approval, so settling a run during
 * that pause is an ordering mistake by the caller. It is reported as its own
 * error rather than an {@link InvalidTransitionError} because nothing illegal
 * happened — the caller simply has to resolve the approval first.
 *
 * The alternative, silently withdrawing the pending approval, would be worse:
 * the task could then report success for an operation that never ran.
 */
export class ApprovalPendingError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} is waiting for an approval decision; resolve it before settling the run`)
    this.name = 'ApprovalPendingError'
  }
}
