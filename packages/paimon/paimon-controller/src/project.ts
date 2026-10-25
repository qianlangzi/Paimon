/**
 * Domain-to-DTO projection.
 *
 * Separate from `types.ts` on purpose: this half imports the domain and the
 * harness adapter, and the browser must never compile that graph. Only the Host
 * — and tests — load this module.
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
import type {
  CheckDto,
  RunDto,
  TaskDetailDto,
  TaskEventDto,
  TaskEventValue,
  TaskOutcomeDto,
  TaskRowDto,
  TaskStatusDto,
} from './types.ts'

/**
 * Compile-time proof that the pinned wire unions still match the domain.
 *
 * If the governance layer gains a status, this line fails and the contract has
 * to be updated deliberately instead of silently widening.
 */
const _statusesAgree: TaskStatusDto extends TaskStatus ? TaskStatus extends TaskStatusDto ? true : never : never = true
const _outcomesAgree: TaskOutcomeDto extends TaskOutcome ? TaskOutcome extends TaskOutcomeDto ? true : never : never = true
void _statusesAgree
void _outcomesAgree

/** Builds the list row for one task. */
export function toTaskRow(task: Task): TaskRowDto {
  // A hand-edited or half-written history can carry an unparseable timestamp;
  // `new Date(NaN).toISOString()` throws, and one bad row must not take the
  // whole list down with it.
  const startedMs = task.startedAt === undefined ? Number.NaN : Date.parse(task.startedAt)
  const deadlineAt = task.deadlineMs === undefined || !Number.isFinite(startedMs)
    ? undefined
    : new Date(startedMs + task.deadlineMs).toISOString()
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
    ...deadlineAt === undefined ? {} : { deadlineAt },
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
  const decisions = retryDecisions(events)
  return {
    ...toTaskRow(task),
    ...task.workspace === undefined ? {} : { workspace: task.workspace },
    cancel: {
      ...task.cancelRequestedAt === undefined ? {} : { requestedAt: task.cancelRequestedAt },
      ...task.cancelAcknowledgedAt === undefined ? {} : { acknowledgedAt: task.cancelAcknowledgedAt },
    },
    runs: runs.map(run => toRun(run, decisions.get(run.id))),
    events: events.map(toEvent),
    ...validation === undefined ? {} : { validation },
    retry: {
      maxAttempts: detail.retryPolicy.maxAttempts,
      retryableKinds: detail.retryPolicy.retryableKinds,
    },
  }
}

/** One attempt's retry verdict, as the runtime recorded it. */
interface RetryVerdict {
  readonly decision?: string
  readonly reason?: string
}

/**
 * Collects the retry verdict of every settled attempt.
 *
 * The verdict lives in the `run/ended` event and nowhere else, so it has to be
 * joined onto the run here rather than looked up by a view: the detail payload
 * is windowed, and a view that scanned the window for verdicts would lose the
 * early attempts — exactly the ones a diagnosis is about.
 */
function retryDecisions(events: readonly TaskEvent[]): ReadonlyMap<string, RetryVerdict> {
  const verdicts = new Map<string, RetryVerdict>()
  for (const event of events) {
    if (event.type !== 'run/ended' || event.runId === undefined) continue
    const decision = event.data.retry
    const reason = event.data.reason
    verdicts.set(event.runId, {
      ...typeof decision === 'string' ? { decision } : {},
      ...typeof reason === 'string' ? { reason } : {},
    })
  }
  return verdicts
}

function toRun(run: Run, verdict: RetryVerdict | undefined): RunDto {
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    startedAt: run.startedAt,
    timedOut: run.timedOut,
    ...run.endedAt === undefined ? {} : { endedAt: run.endedAt },
    ...run.error === undefined ? {} : { errorKind: run.error.kind },
    ...run.resultSummary === undefined ? {} : { resultSummary: run.resultSummary },
    ...verdict?.decision === undefined ? {} : { retryDecision: verdict.decision },
    ...verdict?.reason === undefined ? {} : { retryReason: verdict.reason },
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
