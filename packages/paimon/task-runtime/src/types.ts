/**
 * Paimon task governance domain model.
 *
 * These types are deliberately free of any DSH or Cordis dependency. The
 * harness already owns the agent loop, tool pipeline, approval seam and
 * session log; what it does not own is a *task* that outlives a turn and can
 * end in a verified terminal state. That is the whole reason this package
 * exists, so the model has to stand on its own and stay testable in isolation.
 *
 * Naming note: DSH uses Session -> Turn -> Step. Paimon adds Task -> Run on
 * top. A Task is the user's goal. A Run is one attempt at that goal. Retrying
 * appends a Run; it never rewrites the previous one.
 */

/** Lifecycle of a user goal. Terminal states have no outgoing transitions. */
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'

/** Lifecycle of one execution attempt inside a task. */
export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'

/** Task states from which no further transition is allowed. */
export type TerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'

/** The outcome recorded on a finished task, as a lowercase discriminator. */
export type TaskOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed-out'

/** Every status that ends a task, in a stable order for reporting. */
export const TASK_TERMINAL_STATUSES: readonly TerminalStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]

/** Every status that ends a run, in a stable order for reporting. */
export const RUN_TERMINAL_STATUSES: readonly TerminalStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]

/** Narrows a task status to the terminal subset. */
export function isTerminalTaskStatus(status: TaskStatus): status is TerminalStatus {
  return (TASK_TERMINAL_STATUSES as readonly TaskStatus[]).includes(status)
}

/** Narrows a run status to the terminal subset. */
export function isTerminalRunStatus(status: RunStatus): status is TerminalStatus {
  return (RUN_TERMINAL_STATUSES as readonly RunStatus[]).includes(status)
}

/** Maps a terminal task status onto the outcome vocabulary used in reports. */
export function outcomeOf(status: TerminalStatus): TaskOutcome {
  switch (status) {
    case 'SUCCEEDED': return 'succeeded'
    case 'FAILED': return 'failed'
    case 'CANCELLED': return 'cancelled'
    case 'TIMED_OUT': return 'timed-out'
  }
}

/** One user goal and its current lifecycle position. */
export interface Task {
  readonly id: string
  readonly goal: string
  status: TaskStatus
  /** Absolute directory the task is allowed to touch, when it declares one. */
  workspace: string | undefined
  /** Wall-clock budget for the whole task, measured from `startedAt`. */
  deadlineMs: number | undefined
  readonly createdAt: string
  updatedAt: string
  /** First moment a run started; the deadline is measured from here. */
  startedAt: string | undefined
  /** Moment the user asked to stop. Distinct from actually being stopped. */
  cancelRequestedAt: string | undefined
  /** Moment the executor confirmed it stopped. */
  cancelAcknowledgedAt: string | undefined
  currentRunId: string | undefined
  readonly runIds: string[]
  finalResult: TaskResult | undefined
}

/** One execution attempt inside a task. */
export interface Run {
  readonly id: string
  readonly taskId: string
  /** 1-based attempt counter. Retrying appends `attempt + 1`. */
  readonly attempt: number
  status: RunStatus
  readonly startedAt: string
  endedAt: string | undefined
  error: TaskError | undefined
  resultSummary: string | undefined
  /** Set when the run was stopped by the task deadline rather than the model. */
  timedOut: boolean
}

/** Structured, non-throwing description of why something failed. */
export interface TaskError {
  readonly kind: TaskErrorKind
  readonly message: string
  readonly detail: string | undefined
}

/** Failure classes that drive retry decisions. */
export type TaskErrorKind =
  | 'model'
  | 'tool'
  | 'validation'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'internal'

/** The report attached to a finished task. */
export interface TaskResult {
  readonly outcome: TaskOutcome
  readonly summary: string
  /** Present only when the task reached the validator. */
  readonly validation: ValidationReport | undefined
  /** Which run produced this result. */
  readonly runId: string | undefined
}

/** One piece of evidence the validator may consult. */
export type EvidenceKind =
  | 'tool-result'
  | 'command-exit'
  | 'test-report'
  | 'file-state'
  | 'model-claim'

/** Evidence collected during a run. */
export interface Evidence {
  readonly id: string
  readonly kind: EvidenceKind
  /** Stable reference such as `tool:abc123` or `cmd:pnpm test`. */
  readonly ref: string
  /** `undefined` means the evidence exists but is inconclusive. */
  readonly passed: boolean | undefined
  readonly detail: string
}

/** Outcome of a single completion check. */
export type CheckOutcome = 'passed' | 'failed' | 'not-checked'

/** Result of evaluating one completion rule. */
export interface ValidationCheck {
  readonly id: string
  readonly description: string
  readonly outcome: CheckOutcome
  /** Evidence ids that were consulted, authoritative ones first. */
  readonly evidence: readonly string[]
  readonly note: string | undefined
}

/** Result of evaluating every completion rule for a task. */
export interface ValidationReport {
  /** True only when at least one rule exists and every rule passed. */
  readonly satisfied: boolean
  readonly checks: readonly ValidationCheck[]
}

/**
 * Stable event names. Modules must reuse these instead of inventing a second
 * name for the same fact, so a task timeline stays queryable across versions.
 */
export const TASK_EVENT_TYPES = [
  'task/created',
  'task/status-changed',
  'task/cancel-requested',
  'task/cancel-acknowledged',
  'run/started',
  'run/ended',
  'tool/requested',
  'tool/allowed',
  'tool/denied',
  'tool/approval-required',
  'tool/approval-decided',
  'tool/executed',
  'tool/failed',
  'validation/completed',
] as const

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number]

/** One durable fact in a task timeline. */
export interface TaskEvent {
  readonly id: string
  readonly taskId: string
  readonly runId: string | undefined
  readonly type: TaskEventType
  readonly timestamp: string
  /** Already redacted by the recorder; safe to persist and display. */
  readonly data: Readonly<Record<string, unknown>>
}

/** Filter accepted by event queries. Every provided field must match. */
export interface EventFilter {
  readonly taskId?: string
  readonly runId?: string
  readonly type?: TaskEventType
}
