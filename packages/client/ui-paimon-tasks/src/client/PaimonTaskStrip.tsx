/**
 * PaimonTaskStrip: a one-line summary of the task governance layer, docked
 * above the composer.
 *
 * It answers "is anything still running, and does anything need me?" without
 * opening a panel. The row set arrives from the Host through the generated
 * `paimonTask` Remote namespace and is polled rather than streamed: the list
 * changes on the scale of tool calls, not keystrokes, and a poll cannot leak a
 * subscription when the strip unmounts.
 *
 * Renders nothing while the first read is in flight or when no task exists —
 * an empty strip is noise, and this dock is shared with other surfaces.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskRowDto } from '@deepseek-ai/dsh-paimon-controller/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaimonTaskStripInjected } from './slots.ts'
import css from './PaimonTaskStrip.module.css'

/** How often the strip re-reads the task list, in milliseconds. */
export const REFRESH_INTERVAL_MS = 15_000

/** Truncation budget for the newest goal; the full text is in the title. */
const GOAL_PREVIEW_CHARS = 80

export interface PaimonTaskStripProps extends PaimonTaskStripInjected {
  /** Poll interval override, for tests. */
  refreshIntervalMs?: number
}

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

export function PaimonTaskStrip({
  load,
  refreshIntervalMs = REFRESH_INTERVAL_MS,
  t,
}: PaimonTaskStripProps & PropsLocale<'paimonTasks'>) {
  const [rows, setRows] = useState<readonly TaskRowDto[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

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

  if (error !== undefined) {
    return (
      <div className={css.strip} data-state="error">
        <span className={css.error}>{t('strip.error', { message: error })}</span>
        <button type="button" className={css.refresh} onClick={refresh} title={t('strip.refresh')}>
          ↻
        </button>
      </div>
    )
  }
  if (rows === undefined || rows.length === 0) return null

  const { total, running, waiting } = summarise(rows)
  const newest = rows[0]
  return (
    <div className={css.strip} data-state={waiting > 0 ? 'waiting' : 'idle'}>
      <span className={css.count}>{t('strip.count', { count: total })}</span>
      {running > 0 && <span className={css.running}>{t('strip.running', { count: running })}</span>}
      {waiting > 0 && <span className={css.waiting}>{t('strip.waiting', { count: waiting })}</span>}
      {newest !== undefined && (
        <span className={css.newest} title={newest.goal}>{t('strip.newest', { goal: preview(newest.goal) })}</span>
      )}
      <button type="button" className={css.refresh} onClick={refresh} title={t('strip.refresh')}>
        ↻
      </button>
    </div>
  )
}
