import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it } from 'vitest'
import PaimonTaskService from '../src/index.ts'

/**
 * The wiring between the `persist` config flag and the file store.
 *
 * The store itself has its own spec; what is unverified without this file is
 * the decision made in the adapter — that `persist: true` reaches
 * `$DSH_HOME/paimon/tasks` and that the default writes nothing at all. A test
 * that accidentally wrote into the developer's real harness home would be the
 * exact failure this flag exists to prevent, so the check is worth its weight.
 */

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'paimon-dsh-home-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

/** Boots the minimum plugin set the adapter injects. */
async function mount(config?: { persist?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(PaimonTaskService, config ?? {})
  return ctx
}

async function withDshHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

const agent = { id: 'agent-1' } as unknown as Agent
const workspace = resolve('/tmp/paimon-persist-ws')

describe('persistence wiring', () => {
  it('keeps tasks under $DSH_HOME/paimon/tasks when persist is on', async () => {
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount({ persist: true })
      const task = ctx.paimonTasks.bind(agent, { goal: 'survive a restart', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      const tasksFile = join(home, 'paimon', 'tasks', 'tasks.json')
      expect(existsSync(tasksFile)).toBe(true)
      expect(readFileSync(tasksFile, 'utf8')).toContain('survive a restart')

      // A second boot over the same home stands in for a restart.
      const reborn = await mount({ persist: true })
      expect(reborn.paimonTasks.runtime.getTask(task.id).goal).toBe('survive a restart')
      expect(reborn.paimonTasks.runtime.getTask(task.id).status).toBe('RUNNING')
    })
  })

  it('writes nothing when persist is left off', async () => {
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount()
      ctx.paimonTasks.bind(agent, { goal: 'memory only', workspace })

      expect(existsSync(join(home, 'paimon'))).toBe(false)
    })
  })

  it('exposes the declared test tools to the model-facing layer', async () => {
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount({})
      expect(ctx.paimonTasks.testTools).toEqual([])
    })
  })
})

describe('read model', () => {
  it('lists tasks and assembles a detail with a bounded timeline', async () => {
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount()
      const task = ctx.paimonTasks.bind(agent, { goal: 'inspect me', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      expect(ctx.paimonTasks.listTasks().map(item => item.id)).toEqual([task.id])

      const detail = ctx.paimonTasks.taskDetail(task.id, 2)
      expect(detail.task.goal).toBe('inspect me')
      expect(detail.runs).toHaveLength(1)
      expect(detail.events.length).toBeLessThanOrEqual(2)
      expect(detail.events.at(-1)?.type).toBe('run/started')
    })
  })

  it('refuses a detail request for a task that does not exist', async () => {
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount()
      expect(() => ctx.paimonTasks.taskDetail('missing')).toThrow(/missing/)
    })
  })

  it('reads a zero-length window as "no events" rather than "all of them"', async () => {
    // `slice(-0)` is `slice(0)`: the naive implementation answered "no limit"
    // to a caller that asked for nothing.
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount()
      const task = ctx.paimonTasks.bind(agent, { goal: 'inspect me', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      expect(ctx.paimonTasks.taskDetail(task.id).events.length).toBeGreaterThan(0)
      expect(ctx.paimonTasks.taskDetail(task.id, 0).events).toEqual([])
    })
  })
})

describe('completion conditions through the adapter', () => {
  it('keeps the rule specs a caller supplied, and can verify with them', async () => {
    // The adapter is the only path a model-created task takes, and it used to
    // drop `ruleSpecs` on the floor: the task then had no completion condition
    // at all and could never be verified. Only a real end-to-end run showed it,
    // because the tool specs drive a stubbed service.
    const home = temporaryHome()
    await withDshHome(home, async () => {
      const ctx = await mount({ persist: true })
      const task = ctx.paimonTasks.bind(agent, {
        goal: 'verifiable',
        workspace,
        ruleSpecs: [{ kind: 'any-tool-success', id: 'tool-success', description: 'something ran' }],
      })
      ctx.paimonTasks.runtime.startRun(task.id)

      expect(ctx.paimonTasks.runtime.getTask(task.id).ruleSpecs).toHaveLength(1)
      const report = ctx.paimonTasks.runtime.checkCompletion(task.id, [
        { id: 'e1', kind: 'tool-result', ref: 'tool:read_file', passed: true, detail: 'ok' },
      ])
      expect(report.checks.map(check => check.id)).toEqual(['tool-success'])
      expect(report.satisfied).toBe(true)
    })
  })
})
