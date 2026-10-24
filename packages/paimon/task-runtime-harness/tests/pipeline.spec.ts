import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { testReportRule } from '@deepseek-ai/dsh-paimon-task-runtime'
import { describe, expect, it } from 'vitest'
import PaimonTaskService from '../src/index.ts'

/**
 * Integration against the real tool pipeline.
 *
 * Unlike the unit specs, nothing here is stubbed: `ToolRuntime`,
 * `NativeToolExecutor` and `ApprovalService` are the shipped plugins, and
 * `executeToolFixture` drives the same `tools/pre-execute` waterfall the agent
 * loop drives. The only stand-in is the agent reference, which the adapter
 * reads solely for its `id`.
 *
 * This is what proves the adapter is wired to the harness rather than merely
 * self-consistent.
 */

const signal = new AbortController().signal
const workspace = resolve('/tmp/paimon-pipeline-ws')

const readTool = defineTool({
  name: 'read_file',
  description: 'Read a file.',
  parameters: { path: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute: args => Promise.resolve(`read ${args.path}`),
})

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(PaimonTaskService)
  ctx.tools.register(readTool)

  const agent = { id: 'agent-1' } as unknown as Agent
  const call = (callId: string, path: string, who: Agent = agent): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, {
      signal,
      callId: ToolCallId(callId),
      name: 'read_file',
      arguments: { path },
      agent: who,
    })
  return { ctx, agent, call }
}

function textOf(result: ToolExecutionResult): string {
  return JSON.stringify(result.content)
}

describe('pipeline integration: the real waterfall reaches the adapter', () => {
  it('lets a call through for an agent with no task', async () => {
    const { ctx, call } = await mount()
    try {
      const result = await call('c1', resolve('/etc/passwd'))
      expect(result.isError).toBe(false)
      expect(textOf(result)).toContain('read ')
    } finally { await ctx.fiber.dispose() }
  })

  it('denies a path outside the bound workspace', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, { goal: 'edit code', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      const result = await call('c1', resolve('/etc/passwd'))
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('outside the task workspace')
    } finally { await ctx.fiber.dispose() }
  })

  it('allows a path inside the bound workspace', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, { goal: 'edit code', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      const result = await call('c1', resolve(workspace, 'src/a.ts'))
      expect(result.isError).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves a different agent unmanaged', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, { goal: 'edit code', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      const stranger = { id: 'agent-2' } as unknown as Agent
      const result = await call('c1', resolve('/etc/passwd'), stranger)
      expect(result.isError).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('blocks every call once cancellation is requested', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, { goal: 'edit code', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)
      ctx.paimonTasks.bindings.requestCancel(agent)

      const result = await call('c1', resolve(workspace, 'src/a.ts'))
      expect(result.isError).toBe(true)
      // The adapter answers `cancel`, so the harness renders its canonical
      // pre-dispatch abort rather than a policy denial — the call never ran,
      // and the model is not told a rule refused it.
      expect(textOf(result)).toContain('aborted before dispatch')
      expect(textOf(result)).not.toContain('read ')
    } finally { await ctx.fiber.dispose() }
  })

  it('stops gating after the task finishes', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, {
        goal: 'edit code',
        workspace,
        rules: [testReportRule({ id: 'tests', description: 'tests pass' })],
      })
      ctx.paimonTasks.runtime.startRun(task.id)
      ctx.paimonTasks.bindings.recordToolOutcome(agent, {
        callId: 'c0',
        toolName: 'run_tests',
        result: { isError: false },
        testTools: ['run_tests'],
      })
      ctx.paimonTasks.runtime.completeRun(task.id, ctx.paimonTasks.bindings.evidenceOf(agent), 'done')

      const result = await call('c1', resolve('/etc/passwd'))
      expect(result.isError).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })
})

describe('pipeline integration: observed results become evidence', () => {
  it('records the tool outcome on the task timeline', async () => {
    const { ctx, agent, call } = await mount()
    try {
      const task = ctx.paimonTasks.bind(agent, { goal: 'edit code', workspace })
      ctx.paimonTasks.runtime.startRun(task.id)

      await call('c1', resolve(workspace, 'src/a.ts'))

      const types = ctx.paimonTasks.runtime.getEvents(task.id).map(event => event.type)
      expect(types).toContain('tool/requested')
      expect(types).toContain('tool/executed')
      expect(ctx.paimonTasks.bindings.evidenceOf(agent).length).toBeGreaterThan(0)
    } finally { await ctx.fiber.dispose() }
  })
})
