// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TaskRowDto } from '@deepseek-ai/dsh-paimon-controller/types'
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

function makeLoad(rows: readonly TaskRowDto[]) {
  return vi.fn<PaimonTaskStripInjected['load']>(() => Promise.resolve({ ok: true, value: rows }))
}

describe('PaimonTaskStrip', () => {
  it('renders nothing while the list is empty', async () => {
    const { container } = render(<PaimonTaskStrip load={makeLoad([])} t={t} />)
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('summarises the open work and names the most recent task', async () => {
    const rows = [
      row({ id: 't2', goal: 'delete the temp directory', status: 'WAITING_APPROVAL', needsApproval: true }),
      row({ id: 't1' }),
    ]
    render(<PaimonTaskStrip load={makeLoad(rows)} t={t} />)

    expect(await screen.findByText('2 个任务')).toBeTruthy()
    expect(screen.getByText('1 个运行中')).toBeTruthy()
    expect(screen.getByText('1 个待审批')).toBeTruthy()
    expect(screen.getByText('最新：delete the temp directory')).toBeTruthy()
  })

  it('marks the strip as waiting when a decision is outstanding', async () => {
    const { container } = render(
      <PaimonTaskStrip load={makeLoad([row({ needsApproval: true, status: 'WAITING_APPROVAL' })])} t={t} />,
    )
    await screen.findByText('1 个待审批')
    expect((container.firstChild as HTMLElement).dataset.state).toBe('waiting')
  })

  it('truncates a long goal but keeps the whole text in the title', async () => {
    const goal = `x${'y'.repeat(200)}`
    render(<PaimonTaskStrip load={makeLoad([row({ goal })])} t={t} />)

    const label = await screen.findByTitle(goal)
    expect(label.textContent).toContain('…')
    expect(label.textContent?.length).toBeLessThan(goal.length)
  })

  it('reports a failed read and retries on refresh', async () => {
    const load = vi.fn<PaimonTaskStripInjected['load']>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'host offline' } as never })
      .mockResolvedValueOnce({ ok: true, value: [row()] })

    render(<PaimonTaskStrip load={load} t={t} />)
    expect(await screen.findByText('任务读取失败：host offline')).toBeTruthy()

    fireEvent.click(screen.getByTitle('刷新任务'))
    expect(await screen.findByText('1 个运行中')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected read instead of rendering an empty strip', async () => {
    const load = vi.fn<PaimonTaskStripInjected['load']>(() => Promise.reject(new Error('gateway closed')))
    render(<PaimonTaskStrip load={load} t={t} />)
    expect(await screen.findByText('任务读取失败：gateway closed')).toBeTruthy()
  })
})
