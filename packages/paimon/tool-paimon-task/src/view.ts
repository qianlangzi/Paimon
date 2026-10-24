/**
 * Pure projections from task domain objects to model-facing tool values.
 *
 * Kept separate from the plugin so the shapes the model sees can be tested
 * without a Cordis context. Every function here is a pure function of its
 * arguments: no clock, no I/O, no session access.
 */

import type { Run, Task, ValidationReport } from '@deepseek-ai/dsh-paimon-task-runtime'

/** Compact task description shared by the create and status tools. */
export interface TaskSummary {
  readonly taskId: string
  readonly goal: string
  readonly status: string
  readonly attempt: number
  readonly cancelRequested: boolean
  readonly workspace?: string
  readonly deadlineMs?: number
  readonly outcome?: string
}

/** One completion check as the model sees it. */
export interface CheckSummary {
  readonly id: string
  readonly outcome: string
  readonly note?: string
}

/** The validation report as the model sees it. */
export interface ReportSummary {
  readonly satisfied: boolean
  readonly checks: CheckSummary[]
}

/** One timeline entry as the model sees it. */
export interface EventSummary {
  readonly type: string
  readonly timestamp: string
}

/** Builds the shared task summary. */
export function taskSummary(task: Task, runs: readonly Run[]): TaskSummary {
  return {
    taskId: task.id,
    goal: task.goal,
    status: task.status,
    attempt: runs.length,
    cancelRequested: task.cancelRequestedAt !== undefined,
    ...task.workspace === undefined ? {} : { workspace: task.workspace },
    ...task.deadlineMs === undefined ? {} : { deadlineMs: task.deadlineMs },
    ...task.finalResult === undefined ? {} : { outcome: task.finalResult.outcome },
  }
}

/** Builds the report summary, dropping the evidence ids the model cannot use. */
export function reportSummary(report: ValidationReport): ReportSummary {
  return {
    satisfied: report.satisfied,
    checks: report.checks.map(check => ({
      id: check.id,
      outcome: check.outcome,
      ...check.note === undefined ? {} : { note: check.note },
    })),
  }
}

/** One row of the task listing. */
export interface TaskRow {
  readonly taskId: string
  readonly goal: string
  readonly status: string
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly outcome?: string
}

/** Builds one listing row. */
export function taskRow(task: Task): TaskRow {
  return {
    taskId: task.id,
    goal: task.goal,
    status: task.status,
    attempt: task.runIds.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...task.finalResult === undefined ? {} : { outcome: task.finalResult.outcome },
  }
}

/**
 * Renders the listing newest-first.
 *
 * Ordering is by `updatedAt` rather than `createdAt`: a long-running task that
 * moved a second ago is what an operator is looking for, not the one that was
 * opened last.
 */
export function renderTaskList(rows: readonly TaskRow[]): string {
  if (rows.length === 0) {
    return 'No tasks recorded. Create one with paimon_task_create.'
  }
  const header = `${rows.length} task(s), most recently updated first:`
  const lines = rows.map(row => [
    `${row.taskId.slice(0, 8)}  ${row.status.padEnd(16)}`,
    `attempt ${row.attempt}`,
    `updated ${row.updatedAt}`,
    row.outcome === undefined ? '' : `outcome ${row.outcome}`,
    `\n    ${row.goal}`,
  ].filter(part => part.length > 0).join('  '))
  return [header, ...lines].join('\n')
}

/**
 * Renders a report as prose for the model.
 *
 * Leads with the verdict so a failing check cannot be missed by skimming, and
 * names each unmet condition with the reason it could not be established.
 */
export function renderReport(report: ReportSummary): string {
  if (report.satisfied) {
    return `All ${report.checks.length} completion condition(s) are satisfied by observed evidence.`
  }
  if (report.checks.length === 0) {
    return 'No completion conditions are configured for this task, so it can never be verified as complete. '
      + 'Create the task with at least one rule.'
  }
  const unmet = report.checks.filter(check => check.outcome !== 'passed')
  const lines = unmet.map(check => `- ${check.id}: ${check.outcome}${check.note === undefined ? '' : ` (${check.note})`}`)
  return `Completion is NOT verified: ${unmet.length} of ${report.checks.length} condition(s) unmet.\n${lines.join('\n')}`
}

/** Renders the shared task summary as prose. */
export function renderSummary(summary: TaskSummary): string {
  const lines = [
    `task ${summary.taskId}: ${summary.status} (attempt ${summary.attempt})`,
    `goal: ${summary.goal}`,
  ]
  if (summary.workspace !== undefined) lines.push(`workspace: ${summary.workspace}`)
  if (summary.deadlineMs !== undefined) lines.push(`deadline: ${summary.deadlineMs}ms`)
  if (summary.cancelRequested) lines.push('a cancellation has been requested')
  if (summary.outcome !== undefined) lines.push(`outcome: ${summary.outcome}`)
  return lines.join('\n')
}

/** Renders a timeline as prose, most recent last. */
export function renderTimeline(events: readonly EventSummary[]): string {
  if (events.length === 0) return 'no events recorded'
  return events.map(event => `${event.timestamp} ${event.type}`).join('\n')
}
