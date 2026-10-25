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
      retryDecision: 'retry',
      retryReason: 'failure kind "tool" is retryable and budget remains (1/3)',
    }],
    events: [
      { type: 'task/created', timestamp: '2026-10-25T05:00:00.000Z', data: {} },
      { type: 'run/started', timestamp: '2026-10-25T05:00:01.000Z', data: {} },
    ],
    validation: {
      satisfied: false,
      checks: [{ id: 'tests', description: 'the tests pass', outcome: 'not-checked', note: 'no report' }],
    },
    retry: { maxAttempts: 3, retryableKinds: ['model', 'tool', 'internal'] },
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
    await waitFor(() => { expect(container.firstChild).toBeNull() })
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

  it('keeps the list a reader is using when a later poll fails', async () => {
    // A poll runs every 15 s; one transport hiccup must not erase the tasks.
    const load = vi.fn<PaimonTaskStripInjected['load']>()
      .mockResolvedValueOnce({ ok: true, value: [row()] })
      .mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'host offline' } as never })

    render(<PaimonTaskStrip load={load} loadDetail={makeLoadDetail()} t={t} refreshIntervalMs={10} />)
    expect(await screen.findByText('1 个运行中')).toBeTruthy()

    expect(await screen.findByText('本次刷新失败')).toBeTruthy()
    // The rows survived: the count and the chip are still there.
    expect(screen.getByText('1 个任务')).toBeTruthy()
    expect(screen.getByTitle('fix the failing test')).toBeTruthy()
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
    await waitFor(() => { expect(screen.queryByTestId('paimon-task-detail')).toBeNull() })

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
    // The record of a task that has not settled carries no report at all, so
    // the field is dropped rather than set to `undefined`: with
    // `exactOptionalPropertyTypes` those are different objects, and only the
    // absent one matches what the Host can actually send.
    const { validation: _noReport, ...unsatisfied } = detail({ events: [], runs: [] })
    render(
      <PaimonTaskStrip
        load={makeLoad([row()])}
        loadDetail={makeLoadDetail({ ok: true, value: unsatisfied })}
        t={t}
      />,
    )
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    expect(await screen.findByText('暂无记录')).toBeTruthy()
  })

  it('ignores a slow detail read for a task the reader has already left', async () => {
    // Two clicks, two in-flight reads, and the transport answers the first one
    // last. Without a ticket the panel ends up showing task A under task B.
    type DetailResult = Awaited<ReturnType<PaimonTaskStripInjected['loadDetail']>>
    const pending: Array<(result: DetailResult) => void> = []
    const loadDetail = vi.fn<PaimonTaskStripInjected['loadDetail']>(
      () => new Promise<DetailResult>((resolve) => { pending.push(resolve) }),
    )
    const rows = [row({ id: 'a', goal: 'task a' }), row({ id: 'b', goal: 'task b' })]

    render(<PaimonTaskStrip load={makeLoad(rows)} loadDetail={loadDetail} t={t} />)
    fireEvent.click(await screen.findByTitle('task a'))
    fireEvent.click(screen.getByTitle('task b'))

    pending[1]?.({ ok: true, value: detail({ id: 'b', goal: 'task b' }) })
    await waitFor(() => {
      expect(screen.getByTestId('paimon-task-detail').textContent).toContain('task b')
    })

    pending[0]?.({ ok: true, value: detail({ id: 'a', goal: 'task a' }) })
    // `waitFor` flushes the state update the stale promise would have queued,
    // so this asserts on what a reader would actually see rather than on the
    // microtask order of the test.
    await waitFor(() => {
      expect(screen.getByTestId('paimon-task-detail').textContent).toContain('task b')
    })
    expect(screen.getByTestId('paimon-task-detail').textContent).not.toContain('task a')
  })
})

describe('PaimonTaskStrip diagnostics', () => {
  it('shows the retry budget, the verdict of each attempt and the boundary', async () => {
    render(<PaimonTaskStrip load={makeLoad([row()])} loadDetail={makeLoadDetail()} t={t} />)
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    fireEvent.click(await screen.findByRole('tab', { name: '诊断' }))

    const panel = screen.getByTestId('paimon-task-diagnostics')
    expect(panel.textContent).toContain('尝试预算 1/3')
    expect(panel.textContent).toContain('还剩 2 次')
    expect(panel.textContent).toContain('可重试：model, tool, internal')
    expect(panel.textContent).toContain('已重试')
    expect(panel.textContent).toContain('failure kind "tool" is retryable')
    expect(panel.textContent).toContain('边界目录 /repo/project')
    expect(panel.textContent).toContain('第 1 次尝试 · FAILED · 1.0 秒')
    // The record tab is swapped out, not stacked underneath.
    expect(screen.queryByText('时间线')).toBeNull()
  })

  it('says a budget is spent rather than showing a negative remainder', async () => {
    render(
      <PaimonTaskStrip
        load={makeLoad([row({ attempt: 3, status: 'FAILED' })])}
        loadDetail={makeLoadDetail({ ok: true, value: detail({ attempt: 3, status: 'FAILED' }) })}
        t={t}
      />,
    )
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    fireEvent.click(await screen.findByRole('tab', { name: '诊断' }))

    const panel = screen.getByTestId('paimon-task-diagnostics')
    expect(panel.textContent).toContain('尝试预算 3/3')
    expect(panel.textContent).toContain('尝试预算已用尽')
    expect(panel.textContent).not.toContain('还剩')
  })

  it('reports a missing deadline instead of an empty one', async () => {
    render(<PaimonTaskStrip load={makeLoad([row()])} loadDetail={makeLoadDetail()} t={t} />)
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    fireEvent.click(await screen.findByRole('tab', { name: '诊断' }))
    expect(screen.getByTestId('paimon-task-diagnostics').textContent).toContain('截止时间 未设时间预算')
  })

  it('goes back to the record when the record tab is chosen again', async () => {
    render(<PaimonTaskStrip load={makeLoad([row()])} loadDetail={makeLoadDetail()} t={t} />)
    fireEvent.click(await screen.findByTitle('fix the failing test'))
    fireEvent.click(await screen.findByRole('tab', { name: '诊断' }))
    fireEvent.click(screen.getByRole('tab', { name: '记录' }))
    expect(await screen.findByText('时间线')).toBeTruthy()
    expect(screen.queryByTestId('paimon-task-diagnostics')).toBeNull()
  })
})
