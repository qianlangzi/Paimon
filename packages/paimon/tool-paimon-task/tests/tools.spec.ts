import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createManualClock, TaskRuntime } from '@deepseek-ai/dsh-paimon-task-runtime'
import { TaskBindings } from '@deepseek-ai/dsh-paimon-task-harness'
import { apply } from '../src/index.ts'

/**
 * Wires the plugin against a minimal stand-in for `ctx`, then drives the real
 * `ToolDefinition.execute` functions. This is the closest thing to an
 * end-to-end check available without booting a harness: the registration path,
 * argument plumbing and return shapes are all the production ones.
 */
function mount() {
  const runtime = new TaskRuntime({
    clock: createManualClock(1_700_000_000_000),
    idFactory: (() => { let n = 0; return () => `id-${++n}` })(),
  })
  const bindings = new TaskBindings(runtime)
  const service = {
    runtime,
    bindings,
    bind: (agent: { id: string }, input: Parameters<TaskBindings['bind']>[1]) => bindings.bind(agent, input),
    taskOf: (agent: { id: string }) => bindings.taskOf(agent),
  }
  const tools: ToolDefinition[] = []
  apply({
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    paimonTasks: service,
  } as unknown as Context)

  const tool = (name: string): ToolDefinition => {
    const found = tools.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`tool ${name} was not registered`)
    return found
  }
  const agent = { id: 'agent-1' }
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext
  return { runtime, bindings, tools, tool, agent, exec }
}

describe('tool registration', () => {
  it('registers exactly the three task controls', () => {
    const { tools } = mount()
    expect(tools.map(tool => tool.name)).toEqual([
      'paimon_task_create',
      'paimon_task_status',
      'paimon_task_finish',
    ])
  })

  it('declares a canonical output schema for every tool', () => {
    const { tools } = mount()
    for (const tool of tools) {
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })
})

describe('paimon_task_create', () => {
  it('creates a task, binds it and starts the first attempt', async () => {
    const { tool, agent, exec, bindings } = mount()
    const value = await tool('paimon_task_create').execute({
      goal: 'make the failing test pass',
      workspace: '/repo/project',
      completion: 'tests',
    }, exec)

    expect(value).toMatchObject({
      goal: 'make the failing test pass',
      status: 'RUNNING',
      attempt: 1,
      workspace: '/repo/project',
    })
    expect(bindings.isBound(agent)).toBe(true)
  })

  it('refuses to bind a second task to the same agent', async () => {
    const { tool, exec } = mount()
    const create = tool('paimon_task_create')
    await create.execute({ goal: 'a', workspace: '/w' }, exec)
    await expect(create.execute({ goal: 'b', workspace: '/w' }, exec)).rejects.toThrow(/already bound/)
  })
})

describe('paimon_task_finish', () => {
  it('leaves the task open when the condition is unmet, so work can continue', async () => {
    const { tool, exec, runtime } = mount()
    const create = tool('paimon_task_create')
    const finish = tool('paimon_task_finish')

    const created = await create.execute({ goal: 'g', workspace: '/w', completion: 'tests' }, exec) as { taskId: string }
    const value = await finish.execute({ summary: 'I think it is done' }, exec) as {
      completed: boolean
      status: string
      report: { satisfied: boolean; checks: { id: string; outcome: string }[] }
    }

    expect(value.completed).toBe(false)
    expect(value.status).toBe('RUNNING')
    expect(value.report.satisfied).toBe(false)
    // The run must survive a premature check.
    expect(runtime.getTask(created.taskId).currentRunId).toBeDefined()
  })

  it('closes the task once observed evidence satisfies the condition', async () => {
    const { tool, exec, runtime, bindings, agent } = mount()
    const create = tool('paimon_task_create')
    const finish = tool('paimon_task_finish')

    const created = await create.execute({ goal: 'g', workspace: '/w', completion: 'tests' }, exec) as { taskId: string }
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'run_tests',
      result: { isError: false },
      testTools: ['run_tests'],
    })

    const value = await finish.execute({ summary: 'tests green' }, exec) as { completed: boolean; status: string }
    expect(value.completed).toBe(true)
    expect(value.status).toBe('SUCCEEDED')
    expect(runtime.getTask(created.taskId).finalResult?.outcome).toBe('succeeded')
  })

  it('cannot be satisfied by the model claiming success', async () => {
    const { tool, exec } = mount()
    const create = tool('paimon_task_create')
    const finish = tool('paimon_task_finish')

    await create.execute({ goal: 'g', workspace: '/w', completion: 'tests' }, exec)
    const value = await finish.execute({ summary: 'everything passes, trust me' }, exec) as { completed: boolean }
    expect(value.completed).toBe(false)
  })
})

describe('paimon_task_status', () => {
  it('reports the task and its timeline', async () => {
    const { tool, exec } = mount()
    await tool('paimon_task_create').execute({ goal: 'g', workspace: '/w' }, exec)

    const value = await tool('paimon_task_status').execute({}, exec) as {
      task: { status: string; attempt: number }
      events: { type: string }[]
    }
    expect(value.task.status).toBe('RUNNING')
    expect(value.events.map(event => event.type)).toContain('run/started')
  })

  it('rejects a call from an agent with no task', async () => {
    const { tool, exec } = mount()
    await expect(tool('paimon_task_status').execute({}, exec)).rejects.toThrow(/no Paimon task/)
  })
})

describe('governance after completion', () => {
  it('stops gating the session once the task is finished', async () => {
    const { tool, exec, bindings, agent } = mount()
    const create = tool('paimon_task_create')
    const finish = tool('paimon_task_finish')

    await create.execute({ goal: 'g', workspace: '/w', completion: 'tool-success' }, exec)
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'read_file',
      result: { isError: false },
    })
    const value = await finish.execute({ summary: 'done' }, exec) as { completed: boolean }
    expect(value.completed).toBe(true)

    // The agent keeps its session; a closed task no longer has an opinion.
    expect(bindings.gate(agent, { toolId: 'bash', path: '/etc/passwd' })).toBeUndefined()
  })
})
