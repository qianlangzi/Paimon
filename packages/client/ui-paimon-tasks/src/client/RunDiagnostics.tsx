/**
 * RunDiagnostics: the fourth view — why this task is where it is.
 *
 * The record tab answers "what happened"; this one answers "why did it stop,
 * and what is left to spend". Three facts make that answerable, and each of
 * them is a decision the Host already recorded rather than something the view
 * derives:
 *
 *  - the retry budget (resolved, so it includes the deployment default),
 *  - the verdict the policy reached after each attempt (`retry` / `stop`) and
 *    the runtime's own sentence for it,
 *  - the boundary the tools were held to.
 *
 * It reads only the detail payload. Nothing here recomputes a retry decision:
 * a view that re-derived one would eventually disagree with the layer that
 * actually made it, and the disagreement would surface as "the UI says it
 * should have retried".
 */

import type { RunDto, TaskDetailDto } from '@deepseek-ai/dsh-paimon-controller/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PaimonTaskStrip.module.css'

export interface RunDiagnosticsProps {
  readonly detail: TaskDetailDto
}

/** Attempts the task may still spend, floored at zero. */
export function attemptsLeft(detail: TaskDetailDto): number {
  return Math.max(0, detail.retry.maxAttempts - detail.attempt)
}

/** Milliseconds an attempt took, or `undefined` while it is still running. */
function durationMs(run: RunDto): number | undefined {
  if (run.endedAt === undefined) return undefined
  const elapsed = Date.parse(run.endedAt) - Date.parse(run.startedAt)
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined
}

/** Renders one attempt's verdict in the reader's language. */
function verdictLabel(run: RunDto, t: PropsLocale<'paimonTasks'>['t']): string {
  switch (run.retryDecision) {
    case 'retry': return t('diag.retried')
    case 'stop': return t('diag.stopped')
    // An attempt that has not settled has no verdict yet, and inventing one
    // would be the one thing this panel must not do.
    default: return t('diag.running')
  }
}

export function RunDiagnostics({ detail, t }: RunDiagnosticsProps & PropsLocale<'paimonTasks'>) {
  const left = attemptsLeft(detail)
  const expired = detail.deadlineAt !== undefined && Date.parse(detail.deadlineAt) <= Date.now()

  return (
    <div data-testid="paimon-task-diagnostics">
      <div className={css.block}>
        <div className={css.blockTitle}>{t('diag.budget', { used: detail.attempt, max: detail.retry.maxAttempts })}</div>
        <div className={css.row}>
          <span className={css.muted}>
            {left === 0 ? t('diag.budgetSpent') : t('diag.budgetLeft', { count: left })}
          </span>
          {detail.retry.retryableKinds.length > 0 && (
            <span className={css.muted}>
              {t('diag.retryable', { kinds: detail.retry.retryableKinds.join(', ') })}
            </span>
          )}
        </div>
      </div>

      <div className={css.block}>
        <div className={css.blockTitle}>{t('diag.deadline', {
          at: detail.deadlineAt === undefined ? t('diag.noDeadline') : detail.deadlineAt.replace('T', ' ').replace('Z', ''),
        })}</div>
        {expired && <div className={css.row}><span data-outcome="failed">{t('diag.deadlineExceeded')}</span></div>}
        <div className={css.row}>
          <span className={css.muted} title={detail.workspace}>
            {detail.workspace === undefined ? t('diag.noWorkspace') : t('diag.workspace', { workspace: detail.workspace })}
          </span>
        </div>
        {detail.cancel.requestedAt !== undefined && (
          <div className={css.row}>
            <span className={css.muted}>{t('diag.cancelRequested', { at: detail.cancel.requestedAt.replace('T', ' ').replace('Z', '') })}</span>
          </div>
        )}
        {detail.cancel.acknowledgedAt !== undefined && (
          <div className={css.row}>
            <span className={css.muted}>{t('diag.cancelAcknowledged', { at: detail.cancel.acknowledgedAt.replace('T', ' ').replace('Z', '') })}</span>
          </div>
        )}
      </div>

      <div className={css.block}>
        <div className={css.blockTitle}>{t('diag.attempts')}</div>
        {detail.runs.length === 0 && <div className={css.muted}>{t('diag.noAttempts')}</div>}
        {detail.runs.map((run) => {
          const elapsed = durationMs(run)
          return (
            <div key={run.id} className={css.diagRow} data-testid="paimon-task-attempt">
              <span data-status={run.status}>
                {t('detail.attempt', { attempt: run.attempt })}
                {' · '}
                {run.status}
                {elapsed === undefined ? '' : ` · ${t('diag.duration', { seconds: (elapsed / 1000).toFixed(1) })}`}
              </span>
              <span className={css.muted}>
                {verdictLabel(run, t)}
                {run.errorKind === undefined ? '' : ` · ${run.errorKind}`}
              </span>
              {run.retryReason !== undefined && (
                <span className={css.diagReason}>{run.retryReason}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
