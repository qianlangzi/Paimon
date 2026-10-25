/**
 * PaimonTaskStrip: the task governance layer, summarised above the composer.
 *
 * It answers "is anything still running, and does anything need me?" without
 * leaving the conversation, and opens one task's record on demand. The row set
 * arrives from the Host through the generated `paimonTask` Remote namespace and
 * is polled rather than streamed: the list changes on the scale of tool calls,
 * not keystrokes, and a poll cannot leak a subscription when the strip unmounts.
 *
 * The detail read is deliberately *not* polled and not prefetched: it is the
 * expensive one (a timeline), a human asks for it explicitly, and refreshing it
 * behind a reader's back would scroll the thing they are reading.
 *
 * Renders nothing while the first read is in flight or when no task exists —
 * an empty strip is noise, and this dock is shared with other surfaces.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunDto, TaskDetailDto, TaskRowDto } from '@deepseek-ai/dsh-paimon-controller/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaimonTaskStripInjected } from './slots.ts'
import { RunDiagnostics } from './RunDiagnostics.tsx'
import css from './PaimonTaskStrip.module.css'

/** How often the strip re-reads the task list, in milliseconds. */
export const REFRESH_INTERVAL_MS = 15_000

/** How many task chips to show before collapsing the rest into a count. */
export const MAX_CHIPS = 3

/** How much of a timeline the detail block renders (it is the tail that matters). */
export const DETAIL_EVENT_LIMIT = 40

/** Timeline rows shown at once; the rest still travel, they just do not render. */
const VISIBLE_EVENTS = 8

/** Truncation budget for the newest goal; the full text is in the title. */
const GOAL_PREVIEW_CHARS = 80

export interface PaimonTaskStripProps extends PaimonTaskStripInjected {
  /** Poll interval override, for tests. */
  refreshIntervalMs?: number
}

/** Which half of the detail panel is showing. */
type DetailTab = 'record' | 'diagnostics'

/** Counts the statuses the strip calls out. */
function summarise(rows: readonly TaskRowDto[]) {
  return {
    total: rows.length,
    running: rows.filter(row => row.status === 'RUNNING').length,
    waiting: rows.filter(row => row.needsApproval).length,
  }
}

function preview(goal: string): string {
  return goal.length <= GOAL_PREVIEW_CHARS ? goal : `${goal.slice(0, GOAL_PREVIEW_CHARS - 1)}…`
}

function runLabel(run: RunDto, t: PropsLocale<'paimonTasks'>['t']): string {
  const attempt = t('detail.attempt', { attempt: run.attempt })
  return run.errorKind === undefined
    ? `${attempt} · ${run.status}`
    : `${attempt} · ${run.status} (${run.errorKind})`
}

export function PaimonTaskStrip({
  load,
  loadDetail,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
  t,
}: PaimonTaskStripProps & PropsLocale<'paimonTasks'>) {
  const [rows, setRows] = useState<readonly TaskRowDto[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<DetailTab>('record')
  const [detail, setDetail] = useState<TaskDetailDto | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [detailBusy, setDetailBusy] = useState(false)
  const mounted = useRef(true)
  /**
   * Identifies the newest detail request.
   *
   * Opening a second task before the first read settles is normal, and both
   * promises then resolve in whatever order the transport gives. Without a
   * ticket the loser overwrites the winner and the panel shows task A's record
   * under task B's chip.
   */
  const detailTicket = useRef(0)

  const read = useCallback(async () => {
    const result = await load()
    // A strip that unmounted mid-read must not set state; React would warn and
    // the value is worthless anyway.
    if (!mounted.current) return
    if (result.ok) {
      setRows(result.value)
      setError(undefined)
      return
    }
    setError(result.error.message)
  }, [load])

  useEffect(() => {
    mounted.current = true
    void read().catch((cause: unknown) => {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    const timer = setInterval(() => { void read().catch(() => {}) }, refreshIntervalMs)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [read, refreshIntervalMs])

  const refresh = useCallback(() => { void read().catch(() => {}) }, [read])

  const openTask = useCallback((taskId: string) => {
    // Closing is a request too: a read still in flight must not reopen the
    // panel the reader just dismissed.
    const ticket = detailTicket.current += 1
    setTab('record')
    if (openId === taskId) {
      setOpenId(undefined)
      setDetail(undefined)
      setDetailError(undefined)
      setDetailBusy(false)
      return
    }
    setOpenId(taskId)
    setDetail(undefined)
    setDetailError(undefined)
    setDetailBusy(true)
    void loadDetail(taskId, DETAIL_EVENT_LIMIT)
      .then((result) => {
        if (!mounted.current || ticket !== detailTicket.current) return
        if (result.ok) setDetail(result.value)
        else setDetailError(result.error.message)
      })
      .catch((cause: unknown) => {
        if (!mounted.current || ticket !== detailTicket.current) return
        setDetailError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (mounted.current && ticket === detailTicket.current) setDetailBusy(false)
      })
  }, [loadDetail, openId])

  // A failed poll only replaces the strip when there is nothing to keep: a
  // transient transport error must not erase a list the reader was using. With
  // rows in hand the error becomes a marker beside them.
  if (rows === undefined || rows.length === 0) {
    if (error === undefined) return null
    return (
      <div className={css.strip} data-state="error">
        <span className={css.error}>{t('strip.error', { message: error })}</span>
        <button type="button" className={css.refresh} onClick={refresh} title={t('strip.refresh')}>
          ↻
        </button>
      </div>
    )
  }

  const { total, running, waiting } = summarise(rows)
  const visible = rows.slice(0, MAX_CHIPS)
  const hidden = rows.length - visible.length

  return (
    <div className={css.wrap}>
      <div className={css.strip} data-state={waiting > 0 ? 'waiting' : 'idle'}>
        <span className={css.count}>{t('strip.count', { count: total })}</span>
        {running > 0 && <span className={css.running}>{t('strip.running', { count: running })}</span>}
        {waiting > 0 && <span className={css.waiting}>{t('strip.waiting', { count: waiting })}</span>}
        {error !== undefined && (
          <span className={css.stale} title={t('strip.error', { message: error })}>{t('strip.stale')}</span>
        )}
        <button type="button" className={css.refresh} onClick={refresh} title={t('strip.refresh')}>
          ↻
        </button>
      </div>

      <div className={css.chips}>
        {visible.map(row => (
          <button
            type="button"
            key={row.id}
            className={css.chip}
            data-status={row.status}
            data-open={row.id === openId ? 'true' : undefined}
            title={row.goal}
            onClick={() => openTask(row.id)}
          >
            {preview(row.goal)}
          </button>
        ))}
        {hidden > 0 && <span className={css.more}>{t('strip.more', { count: hidden })}</span>}
      </div>

      {openId !== undefined && (
        <div className={css.detail} data-testid="paimon-task-detail">
          {detailBusy && <div className={css.muted}>{t('detail.loading')}</div>}
          {detailError !== undefined && (
            <div className={css.error}>{t('detail.error', { message: detailError })}</div>
          )}
          {detail !== undefined && (
            <>
              <div className={css.detailHead}>
                <span className={css.detailGoal} title={detail.goal}>{detail.goal}</span>
                <span className={css.detailStatus} data-status={detail.status}>{detail.status}</span>
                <span className={css.muted}>{t('detail.attempt', { attempt: detail.attempt })}</span>
                {detail.workspace !== undefined && (
                  <span className={css.muted} title={detail.workspace}>
                    {t('detail.workspace', { workspace: detail.workspace })}
                  </span>
                )}
                <button type="button" className={css.close} onClick={() => openTask(detail.id)}>
                  {t('detail.close')}
                </button>
              </div>

              <div className={css.tabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'record'}
                  className={css.tab}
                  data-active={tab === 'record' ? 'true' : undefined}
                  onClick={() => setTab('record')}
                >
                  {t('detail.tab.record')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'diagnostics'}
                  className={css.tab}
                  data-active={tab === 'diagnostics' ? 'true' : undefined}
                  onClick={() => setTab('diagnostics')}
                >
                  {t('detail.tab.diagnostics')}
                </button>
              </div>

              {tab === 'diagnostics' ? (
                <RunDiagnostics detail={detail} t={t} />
              ) : (
                <>
                  {detail.runs.length > 0 && (
                    <div className={css.block}>
                      <div className={css.blockTitle}>{t('detail.runs')}</div>
                      {detail.runs.map(run => (
                        <div key={run.id} className={css.row}>
                          <span data-status={run.status}>{runLabel(run, t)}</span>
                          {run.resultSummary !== undefined && (
                            <span className={css.muted}>{run.resultSummary}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {detail.validation !== undefined && (
                    <div className={css.block}>
                      <div className={css.blockTitle}>
                        {t('detail.checks')}
                        {' · '}
                        {detail.validation.satisfied ? t('detail.verified') : t('detail.unverified')}
                      </div>
                      {detail.validation.checks.map(check => (
                        <div key={check.id} className={css.row}>
                          <span data-outcome={check.outcome}>{check.description}</span>
                          <span className={css.muted}>
                            {check.outcome}
                            {check.note === undefined ? '' : ` — ${check.note}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className={css.block}>
                    <div className={css.blockTitle}>{t('detail.timeline')}</div>
                    {detail.events.length === 0 && <div className={css.muted}>{t('detail.empty')}</div>}
                    {detail.events.slice(-VISIBLE_EVENTS).map((event, index) => (
                      <div key={`${event.timestamp}-${index}`} className={css.row}>
                        <span className={css.eventType}>{event.type}</span>
                        <span className={css.muted}>{event.timestamp.replace('T', ' ').replace('Z', '')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
