// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TaskDetailDto, TaskRowDto } from '@deepseek-ai/dsh-paimon-controller/types'
import { PaimonTaskStrip } from '../src/client/PaimonTaskStrip.tsx'
import type { PaimonTaskStripInjected } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

const t: Parameters<typeof PaimonTaskStrip>[0]['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function row(over: Partial<TaskRowDto> = {}): TaskRowDto {
  return {
    id: 't1',
    goal: 'fix the failing test',
    status: 'RUNNING',
    attempt: 1,
    createdAt: '2026-10-25T05:00:00.000Z',
    updatedAt: '2026-10-25T05:01:00.000Z',
    needsApproval: false,
    ...over,
  }
}

function detail(over: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return {
    ...row(),
    workspace: '/repo/project',
    cancel: {},
    runs: [{
      id: 'r1',
      attempt: 1,
      status: 'FAILED',
      startedAt: '2026-10-25T05:00:01.000Z',
      endedAt: '2026-10-25T05:00:02.000Z',
      timedOut: false,
      errorKind: 'tool',
      resultSummary: 'first attempt',
    }],
    events: [
      { type: 'task/created', timestamp: '2026-10-25T05:00:00.000Z', data: {} },
      { type: 'run/started', timestamp: '2026-10-25T05:00:01.000Z', data: {} },
    ],
    validation: {
      satisfied: false,
      checks: [{ id: 'tests', description: 'the tests pass', outcome: 'not-checked', note: 'no report' }],
    },
    ...over,
  }
}

function makeLoad(rows: readonly TaskRowDto[]) {
  return vi.fn<PaimonTaskStripInjected['load']>(() => Promise.resolve({ ok: true, value: rows }))
}

function makeLoadDetail(result: Awaited<ReturnType<PaimonTaskStripInjected['loadDetail']>> = {
  ok: true,
  value: detail(),
}) {
  return vi.fn<PaimonTaskStripInjected['loadDetail']>(() => Promise.resolve(result))
}

describe('PaimonTaskStrip', () => {
  it('renders nothing while the list is empty', async () => {
    const { container } = render(
      <PaimonTaskStrip load={makeLoad([])} loadDetail={makeLoadDetail()} t={t} />,
    )
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('summarises the open work and names the most recent task', async () => {
    const rows = [
      row({ id: 't2', goal: 'delete the temp directory', status: 'WAITING_APPROVAL', needsApproval: true }),
      row({ id: 't1' }),
    ]
    render(<PaimonTaskStrip load={makeLoad(rows)} loadDetail={makeLoadDetail()} t={t} />)

    expect(await screen.findByText('2 个任务')).toBeTruthy()
    expect(screen.getByText('1 个运行中')).toBeTruthy()
    expect(screen.getByText('1 个待审批')).toBeTruthy()
    // The chips are the list: the newest task is the first one, not a separate line.
    expect(screen.getByTitle('delete the temp directory')).toBeTruthy()
  })

  it('marks the strip as waiting when a decision is outstanding', async () => {
    const { container } = render(
      <PaimonTaskStrip
        load={makeLoad([row({ needsApproval: true, status: 'WAITING_APPROVAL' })])}
        loadDetail={makeLoadDetail()}
        t={t}
      />,
    )
    await screen.findByText('1 个待审批')
    expect((container.querySelector('[data-state="waiting"]') as HTMLElement)).toBeTruthy()
  })

  it('truncates a long goal but keeps the whole text in the title', async () => {
    const goal = `x${'y'.repeat(200)}`
    render(<PaimonTaskStrip load={makeLoad([row({ goal })])} loadDetail={makeLoadDetail()} t={t} />)

    const label = await screen.findByTitle(goal)
    expect(label.textContent).toContain('…')
    expect(label.textContent?.length).toBeLessThan(goal.length)
  })

  it('collapses the tasks it cannot show into a count', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' }), row({ id: 'd' }), row({ id: 'e' })]
    render(<PaimonTaskStrip load={makeLoad(rows)} loadDetail={makeLoadDetail()} t={t} />)

    expect(await screen.findByText('还有 2 个')).toBeTruthy()
  })

  it('reports a failed read and retries on refresh', async () => {
    const load = vi.fn<PaimonTaskStripInjected['load']>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'host offline' } as never })
      .mockResolvedValueOnce({ ok: true, value: [row()] })

    render(<PaimonTaskStrip load={load} loadDetail={makeLoadDetail()} t={t} />)
    expect(await screen.findByText('任务读取失败：host offline')).toBeTruthy()

    fireEvent.click(screen.getByTitle('刷新任务'))
    expect(await screen.findByText('1 个运行中')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected read instead of rendering an empty strip', async () => {
    const load = vi.fn<PaimonTaskStripInjected['load']>(() => Promise.reject(new Error('gateway closed')))
    render(<PaimonTaskStrip load={load} loadDetail={makeLoadDetail()} t={t} />)
    expect(await screen.findByText('任务读取失败：gateway closed')).toBeTruthy()
  })
})

describe('PaimonTaskStrip detail', () => {
  it('opens one task with its attempts, checks and timeline', async () => {
    const loadDetail = makeLoadDetail()
    render(<PaimonTaskStrip load={makeLoad([row()])} loadDetail={loadDetail} t={t} />)

    fireEvent.click(await screen.findByTitle('fix the failing test'))
    expect(loadDetail).toHaveBeenCalledWith('t1', expect.any(Number))

    const panel = await screen.findByTestId('paimon-task-detail')
    expect(panel.textContent).toContain('第 1 次尝试')
    expect(panel.textContent).toContain('工作目录：/repo/project')
    expect(panel.textContent).toContain('第 1 次尝试 · FAILED (tool)')
    expect(panel.textContent).toContain('the tests pass')
    expect(panel.textContent).toContain('尚未确认')
    expect(panel.textContent).toContain('run/started')
  })

  it('closes the panel when the same task is clicked again, and refetches on reopen', async () => {
    const loadDetail = makeLoadDetail()
    render(<PaimonTaskStrip load={makeLoad([row()])} loadDetail={loadDetail} t={t} />)

    const chip = await screen.findByTitle('fix the failing test')
    fireEvent.click(chip)
    await screen.findByTestId('paimon-task-detail')

    fireEvent.click(chip)
    await waitFor(() => expect(screen.queryByTestId('paimon-task-detail')).toBeNull())

    fireEvent.click(chip)
    await screen.findByTestId('paimon-task-detail')
    expect(loadDetail).toHaveBeenCalledTimes(2)
  })

  it('reports a detail read failure without hiding the list', async () => {
    render(
      <PaimonTaskStrip
        load={makeLoad([row()])}
        loadDetail={makeLoadDetail({ ok: false, error: { code: 'not-found', message: 'no such task' } as never })}
        t={t}
      />,
    )

    fireEvent.click(await screen.findByTitle('fix the failing test'))
    expect(await screen.findByText('任务详情读取失败：no such task')).toBeTruthy()
    // The summary stayed readable: one failed detail does not erase the list.
    expect(screen.getByText('1 个运行中')).toBeTruthy()
  })

  it('shows an empty-timeline note instead of a blank block', async () => {
    render(
      <PaimonTaskStrip
        load={makeLoad([row()])}
        loadDetail={makeLoadDetail({ ok: true, value: detail({ events: [], runs: [], validation: undefined }) })}
        t={t}
      />,
    )
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    expect(await screen.findByText('暂无记录')).toBeTruthy()
  })
})
