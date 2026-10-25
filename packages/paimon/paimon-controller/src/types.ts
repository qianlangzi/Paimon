/**
 * The shapes the desktop surfaces render.
 *
 * Deliberately *not* the domain types. A remote contract that ships `Task`
 * whole would weld the UI to every future change of the governance layer, and
 * the layer is expected to keep moving. These DTOs carry what a view draws and
 * nothing else, so adding a field to `Task` is not automatically a UI change.
 *
 * Everything here is a pure function of its input: no clock, no I/O, so the
 * mapping can be tested without a harness.
 */

import type {
  Run,
  Task,
  TaskEvent,
  TaskOutcome,
  TaskStatus,
  ValidationReport,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import type { TaskDetail } from '@deepseek-ai/dsh-paimon-task-harness'

/** One row in the task list. */
export interface TaskRowDto {
  readonly id: string
  readonly goal: string
  readonly status: TaskStatus
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
  readonly outcome?: TaskOutcome
  /** Present only when the task declares a budget. */
  readonly deadlineMs?: number
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
}

/** Builds the list row for one task. */
export function toTaskRow(task: Task): TaskRowDto {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    attempt: task.runIds.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    needsApproval: task.status === 'WAITING_APPROVAL',
    ...task.finalResult === undefined ? {} : { outcome: task.finalResult.outcome },
    ...task.deadlineMs === undefined ? {} : { deadlineMs: task.deadlineMs },
  }
}

/**
 * Builds the detail payload.
 *
 * `events` arrive oldest first from the store; the view renders them in that
 * order and scrolls to the end, so they are passed through untouched rather
 * than reversed here.
 */
export function toTaskDetail(detail: TaskDetail): TaskDetailDto {
  const { task, runs, events } = detail
  const final = task.finalResult?.validation
  const validation = final === undefined ? latestReport(events) : toValidation(final)
  return {
    ...toTaskRow(task),
    ...task.workspace === undefined ? {} : { workspace: task.workspace },
    cancel: {
      ...task.cancelRequestedAt === undefined ? {} : { requestedAt: task.cancelRequestedAt },
      ...task.cancelAcknowledgedAt === undefined ? {} : { acknowledgedAt: task.cancelAcknowledgedAt },
    },
    runs: runs.map(toRun),
    events: events.map(toEvent),
    ...validation === undefined ? {} : { validation },
  }
}

function toRun(run: Run): RunDto {
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    startedAt: run.startedAt,
    timedOut: run.timedOut,
    ...run.endedAt === undefined ? {} : { endedAt: run.endedAt },
    ...run.error === undefined ? {} : { errorKind: run.error.kind },
    ...run.resultSummary === undefined ? {} : { resultSummary: run.resultSummary },
  }
}

function toEvent(event: TaskEvent): TaskEventDto {
  return {
    type: event.type,
    timestamp: event.timestamp,
    ...event.runId === undefined ? {} : { runId: event.runId },
    data: toEventData(event.data),
  }
}

function toEventData(data: Readonly<Record<string, unknown>>): Record<string, TaskEventValue> {
  const output: Record<string, TaskEventValue> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    output[key] = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : JSON.stringify(value) ?? null
  }
  return output
}

function toValidation(report: ValidationReport): NonNullable<TaskDetailDto['validation']> {
  return {
    satisfied: report.satisfied,
    checks: report.checks.map(check => ({
      id: check.id,
      description: check.description,
      outcome: check.outcome,
      ...check.note === undefined ? {} : { note: check.note },
    })),
  }
}

/**
 * Reads the last recorded validation report out of the timeline.
 *
 * A task still running has no `finalResult`, but it may already have been
 * probed; showing the most recent attempt's checks is more useful than showing
 * nothing. The report is rebuilt from the event payload because that is the
 * only place a *non-final* report is kept.
 */
function latestReport(events: readonly TaskEvent[]): TaskDetailDto['validation'] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'validation/completed') continue
    const checks = event.data.checks
    if (!Array.isArray(checks)) return undefined
    const parsed = checks.flatMap((entry): CheckDto[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : undefined
      const outcome = typeof record.outcome === 'string' ? record.outcome : undefined
      if (id === undefined || outcome === undefined) return []
      return [{
        id,
        // The event does not carry the description; the id is the stable name.
        description: id,
        outcome,
        ...typeof record.note === 'string' ? { note: record.note } : {},
      }]
    })
    return { satisfied: event.data.satisfied === true, checks: parsed }
  }
  return undefined
}
