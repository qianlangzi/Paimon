/**
 * The shapes the desktop surfaces render.
 *
 * Deliberately *not* the domain types. A remote contract that ships `Task`
 * whole would weld the UI to every future change of the governance layer, and
 * the layer is expected to keep moving. These DTOs carry what a view draws and
 * nothing else, so adding a field to `Task` is not automatically a UI change.
 *
 * **This module imports nothing.** The browser compiles under a face without
 * Node globals, and one `import type` from a host package is enough to drag the
 * whole host source graph — and `node:fs` — into that program. The status
 * unions are therefore pinned here rather than re-exported from the domain:
 * a wire contract should change deliberately, not by following a rename
 * upstream. `project.ts` holds the mapping and asserts the two agree.
 */

/** Task lifecycle as the wire contract spells it. */
export type TaskStatusDto =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'

/** Terminal outcome as the wire contract spells it. */
export type TaskOutcomeDto = 'succeeded' | 'failed' | 'cancelled' | 'timed-out'

/** One row in the task list. */
export interface TaskRowDto {
  readonly id: string
  readonly goal: string
  readonly status: TaskStatusDto
  /** 1-based attempt count; the number of runs started so far. */
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * True while a human decision is outstanding.
   *
   * Carried on the row rather than derived by the view from `status`, so the
   * approval inbox and the list agree on the badge without either of them
   * re-implementing the state machine.
   */
  readonly needsApproval: boolean
  /** Set once the task reached a terminal status. */
  readonly outcome?: TaskOutcomeDto
  /** Present only when the task declares a budget. */
  readonly deadlineMs?: number
  /**
   * The instant the budget runs out, when the task has both started and
   * declared one.
   *
   * Absolute rather than "milliseconds remaining": the remaining time depends
   * on when a view happens to render, and a browser must not have to guess the
   * host's clock.
   */
  readonly deadlineAt?: string
}

/** One attempt in the detail view. */
export interface RunDto {
  readonly id: string
  readonly attempt: number
  readonly status: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly timedOut: boolean
  /** Failure class, when the run failed; no message here, that is the event log. */
  readonly errorKind?: string
  readonly resultSummary?: string
  /**
   * What the retry policy decided after this attempt failed: `retry` or `stop`.
   *
   * Read from the `run/ended` event rather than recomputed, so the view shows
   * the decision that was actually taken, not one it would have taken.
   */
  readonly retryDecision?: string
  /** Why that decision was taken, in the runtime's own words. */
  readonly retryReason?: string
}

/** A value the Remote boundary can carry as-is. */
export type TaskEventValue = string | number | boolean | null

/** One timeline entry. */
export interface TaskEventDto {
  readonly type: string
  readonly timestamp: string
  readonly runId?: string
  /**
   * Already redacted when recorded; safe to render.
   *
   * Scalars only. The Remote boundary cannot carry unconstrained data, so a
   * nested object or array arrives as JSON text — a view that needs the
   * structure should read the typed `validation` block instead of parsing this.
   */
  readonly data: Record<string, TaskEventValue>
}

/** One completion check as a view renders it. */
export interface CheckDto {
  readonly id: string
  readonly description: string
  readonly outcome: string
  readonly note?: string
}

/** The detail view's payload: identity, progress, attempts and timeline. */
export interface TaskDetailDto extends TaskRowDto {
  readonly workspace?: string
  readonly cancel: {
    readonly requestedAt?: string
    readonly acknowledgedAt?: string
  }
  readonly runs: readonly RunDto[]
  readonly events: readonly TaskEventDto[]
  /** The verification report, from the final result or the latest attempt. */
  readonly validation?: { readonly satisfied: boolean; readonly checks: readonly CheckDto[] }
  /**
   * The retry budget this task is judged by, resolved (so it includes the
   * deployment default). The diagnostics view needs it to say how much of the
   * budget is left rather than only how many attempts were spent.
   */
  readonly retry: {
    readonly maxAttempts: number
    readonly retryableKinds: readonly string[]
  }
}
