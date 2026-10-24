import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskRuntime, createManualClock, testReportRule } from '@deepseek-ai/dsh-paimon-task-runtime'
import { TaskBindings } from '../src/binding.ts'

const workspace = resolve('/tmp/paimon-harness-ws')

function harness(rules = [testReportRule({ id: 'tests', description: 'unit tests pass' })]) {
  const clock = createManualClock(1_700_000_000_000)
  let counter = 0
  const runtime = new TaskRuntime({ clock, idFactory: () => `id-${(counter += 1)}` })
  const bindings = new TaskBindings(runtime)
  const agent = { id: 'agent-1' }
  const task = bindings.bind(agent, { goal: 'fix the build', workspace, rules })
  return { bindings, runtime, agent, task, clock }
}

describe('bindings: an unmanaged agent is never touched', () => {
  const stranger = { id: 'agent-stranger' }

  it('reports no task', () => {
    const { bindings } = harness()
    expect(bindings.taskOf(stranger)).toBeUndefined()
    expect(bindings.taskIdOf(stranger)).toBeUndefined()
    expect(bindings.isBound(stranger)).toBe(false)
  })

  it('returns no gate opinion, so the caller delegates unchanged', () => {
    const { bindings } = harness()
    expect(bindings.gate(stranger, { toolId: 'bash', path: resolve('/etc/passwd') })).toBeUndefined()
  })

  it('records nothing', () => {
    const { bindings } = harness()
    expect(bindings.recordToolOutcome(stranger, {
      callId: 'c1',
      toolName: 'bash',
      result: { isError: false },
    })).toEqual([])
    expect(bindings.evidenceOf(stranger)).toEqual([])
  })

  it('has no cancellation to offer', () => {
    const { bindings } = harness()
    expect(bindings.requestCancel(stranger)).toBeUndefined()
    expect(bindings.acknowledgeCancel(stranger)).toBeUndefined()
    expect(bindings.resolveApproval(stranger, true)).toBeUndefined()
  })
})

describe('bindings: association', () => {
  it('creates a task and exposes it', () => {
    const { bindings, agent, task } = harness()
    expect(task.status).toBe('PENDING')
    expect(bindings.isBound(agent)).toBe(true)
    expect(bindings.taskOf(agent)?.id).toBe(task.id)
    expect(bindings.listBindings()).toEqual([{ agentId: agent.id, taskId: task.id }])
  })

  it('refuses to rebind an agent that already has a task', () => {
    const { bindings, agent } = harness()
    expect(() => bindings.bind(agent, { goal: 'second goal' })).toThrow(/already bound/)
  })

  it('drops the association without cancelling the task', () => {
    const { bindings, runtime, agent, task } = harness()
    expect(bindings.unbind(agent)).toBe(true)
    expect(bindings.isBound(agent)).toBe(false)
    // Cleanup must not stop work the user did not ask to stop.
    expect(runtime.getTask(task.id).status).toBe('PENDING')
    expect(bindings.unbind(agent)).toBe(false)
  })
})

describe('bindings: gating', () => {
  it('allows a path inside the workspace', () => {
    const { bindings, agent } = harness()
    expect(bindings.gate(agent, { toolId: 'read_file', path: resolve(workspace, 'src/a.ts') }))
      .toEqual({ kind: 'allow' })
  })

  it('denies a path outside the workspace', () => {
    const { bindings, agent } = harness()
    const decision = bindings.gate(agent, { toolId: 'read_file', path: resolve('/etc/passwd') })
    expect(decision?.kind).toBe('deny')
  })

  it('parks the task while an approval is pending and resumes on grant', () => {
    const { bindings, runtime, agent, task } = harness()
    // Approval only makes sense while work is running; the runtime refuses to
    // ask when there is no active run, so start one first.
    runtime.startRun(task.id)
    const gate = bindings.gate(agent, { toolId: 'rm', requiresApproval: true })
    expect(gate?.kind).toBe('require-approval')
    expect(runtime.getTask(task.id).status).toBe('WAITING_APPROVAL')

    expect(bindings.resolveApproval(agent, true)).toEqual({ kind: 'allow' })
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })

  it('refuses the operation when the approval is declined', () => {
    const { bindings, runtime, agent, task } = harness()
    runtime.startRun(task.id)
    bindings.gate(agent, { toolId: 'rm', requiresApproval: true })
    const decision = bindings.resolveApproval(agent, false, 'too risky')
    expect(decision?.kind).toBe('deny')
    expect(runtime.getTask(task.id).status).toBe('RUNNING')
  })

  it('refuses an approval request when no run is active', () => {
    const { bindings, agent } = harness()
    const decision = bindings.gate(agent, { toolId: 'rm', requiresApproval: true })
    expect(decision?.kind).toBe('deny')
    if (decision?.kind === 'deny') expect(decision.reason).toMatch(/no active run/)
  })

  it('has no approval opinion when the task is not waiting', () => {
    const { bindings, agent } = harness()
    expect(bindings.resolveApproval(agent, true)).toBeUndefined()
  })

  it('stops governing once the task reaches a terminal state', () => {
    const { bindings, runtime, agent, task } = harness()
    runtime.startRun(task.id)
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'run_tests',
      result: { isError: false },
      testTools: ['run_tests'],
    })
    runtime.completeRun(task.id, bindings.evidenceOf(agent), 'done')

    // A finished task must not lock the agent out of its remaining session.
    expect(bindings.gate(agent, { toolId: 'bash', path: resolve('/etc/passwd') })).toBeUndefined()
    expect(bindings.recordToolOutcome(agent, {
      callId: 'c2',
      toolName: 'bash',
      result: { isError: false },
    })).toEqual([])
    // The task is still queryable; only its governance ended.
    expect(bindings.taskOf(agent)?.status).toBe('SUCCEEDED')
  })
})

describe('bindings: evidence', () => {
  it('accumulates evidence per task', () => {
    const { bindings, agent } = harness()
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'run_tests',
      result: { isError: false },
      testTools: ['run_tests'],
    })
    const evidence = bindings.evidenceOf(agent)
    expect(evidence.map(item => item.kind)).toEqual(['tool-result', 'test-report'])
  })

  it('records the outcome on the task timeline', () => {
    const { bindings, runtime, agent, task } = harness()
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'bash',
      result: { isError: true, error: { message: 'exit 1' } },
    })
    const failed = runtime.getEvents(task.id).filter(event => event.type === 'tool/failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data.detail).toBe('exit 1')
  })

  it('feeds the accumulated evidence into completion', () => {
    const { bindings, runtime, agent, task } = harness()
    bindings.recordToolOutcome(agent, {
      callId: 'c1',
      toolName: 'run_tests',
      result: { isError: false },
      testTools: ['run_tests'],
    })
    runtime.startRun(task.id)
    const outcome = runtime.completeRun(task.id, bindings.evidenceOf(agent), 'tests green')
    expect(outcome.kind).toBe('succeeded')
  })
})

describe('bindings: cancellation', () => {
  it('separates the request from the acknowledgement', () => {
    const { bindings, runtime, agent, task } = harness()
    runtime.startRun(task.id)

    expect(bindings.requestCancel(agent)?.status).toBe('RUNNING')
    expect(runtime.getTask(task.id).cancelRequestedAt).toBeDefined()

    expect(bindings.acknowledgeCancel(agent)?.status).toBe('CANCELLED')
  })

  it('refuses new tool calls once cancellation is requested', () => {
    const { bindings, runtime, agent, task } = harness()
    runtime.startRun(task.id)
    bindings.requestCancel(agent)
    expect(bindings.gate(agent, { toolId: 'bash' })?.kind).toBe('cancelled')
  })
})
