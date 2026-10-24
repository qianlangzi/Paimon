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
