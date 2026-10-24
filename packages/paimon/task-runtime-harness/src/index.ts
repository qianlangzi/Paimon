/**
 * Paimon harness adapter.
 *
 * Wires the task governance layer into the harness's existing extension points
 * rather than replacing any of them:
 *
 * - `tools/pre-execute` waterfall → {@link TaskBindings.gate} → `PreToolDecision`
 * - `ctx.approval` seam          → {@link TaskBindings.resolveApproval}
 * - `tools/result` observation   → {@link TaskBindings.recordToolOutcome}
 * - `agent.cancel`               → request/acknowledge cancellation
 *
 * An agent with no bound task is never touched: every routing method returns
 * `undefined` and the listener delegates unchanged. Opting in is explicit,
 * because silently imposing task semantics on every session would change
 * behaviour for users who never asked for it.
 *
 * @module @deepseek-ai/dsh-paimon-task-harness
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  TaskRuntime,
  type CreateTaskInput,
  type Task,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { TaskBindings, type AgentRef } from './binding.ts'
import { type ResolvedApproval, approvalToResolved, toPreToolDecision } from './mapping.ts'
import { DEFAULT_PATH_ARGUMENT_KEYS, extractPathArgument } from './path-args.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Task governance over the harness tool pipeline. */
    paimonTasks: PaimonTaskService
  }
}

/** Plugin configuration. Every field has a safe default. */
export interface Config {
  /**
   * Tool names that require a human decision before running.
   *
   * Empty by default: the adapter must not start prompting users for tools the
   * harness itself would have run silently.
   */
  readonly approvalTools?: string[]
  /** Argument keys treated as filesystem paths for the workspace boundary. */
  readonly pathArgumentKeys?: string[]
  /**
   * Tool names whose success means "the tests passed".
   *
   * Declared, never inferred: the adapter will not guess a test report out of
   * arbitrary output.
   */
  readonly testTools?: string[]
  /** Default wall-clock budget applied by {@link PaimonTaskService.bind}. */
  readonly deadlineMs?: number
  /** Strings scrubbed from every recorded task event. */
  readonly knownSecrets?: string[]
}

/** What a caller supplies when binding a task to an agent. */
export interface BindInput {
  readonly goal: string
  readonly workspace?: string | undefined
  readonly deadlineMs?: number | undefined
  readonly rules?: CreateTaskInput['rules']
  readonly retryPolicy?: CreateTaskInput['retryPolicy']
}

/**
 * The adapter service, exposed as `ctx.paimonTasks`.
 *
 * Requires `tools` and `approval`: the shipped `dsh-base` bundle composes both,
 * so a deployment that omits `user-approval` will simply not activate this
 * plugin rather than silently running without an approval path.
 */
export class PaimonTaskService extends Service {
  static inject = ['tools', 'approval']

  static Config: z<Config> = z.object({
    approvalTools: z.array(z.string()).default([]),
    pathArgumentKeys: z.array(z.string()).default([...DEFAULT_PATH_ARGUMENT_KEYS]),
    testTools: z.array(z.string()).default([]),
    deadlineMs: z.number().default(0),
    knownSecrets: z.array(z.string()).default([]),
  })

  readonly #bindings: TaskBindings
  readonly #approvalTools: ReadonlySet<string>
  readonly #testTools: ReadonlySet<string>
  readonly #pathKeys: readonly string[]
  readonly #defaultDeadlineMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paimonTasks')
    this.#approvalTools = new Set(config.approvalTools ?? [])
    this.#testTools = new Set(config.testTools ?? [])
    this.#pathKeys = config.pathArgumentKeys ?? DEFAULT_PATH_ARGUMENT_KEYS
    this.#defaultDeadlineMs = config.deadlineMs ?? 0
    this.#bindings = new TaskBindings(new TaskRuntime({
      knownSecrets: config.knownSecrets ?? [],
    }))

    this.ctx.on('tools/pre-execute', async (exec, next) => this.#gate(exec, next))
    this.ctx.on('tools/result', (exec, result) => { this.#observe(exec, result) })
  }

  /** The governance runtime, for queries and completion. */
  get runtime(): TaskRuntime {
    return this.#bindings.runtime
  }

  /** The agent-to-task associations this adapter manages. */
  get bindings(): TaskBindings {
    return this.#bindings
  }

  /**
   * Creates a task and binds it to an agent.
   *
   * Applies the configured deadline when the caller does not supply one; a
   * configured value of `0` means "no default budget".
   */
  bind(agent: AgentRef, input: BindInput): Task {
    const deadlineMs = input.deadlineMs
      ?? (this.#defaultDeadlineMs > 0 ? this.#defaultDeadlineMs : undefined)
    return this.#bindings.bind(agent, {
      goal: input.goal,
      workspace: input.workspace,
      deadlineMs,
      rules: input.rules,
      retryPolicy: input.retryPolicy,
    })
  }

  /** The task bound to this agent, if any. */
  taskOf(agent: AgentRef): Task | undefined {
    return this.#bindings.taskOf(agent)
  }

  /**
   * Stops the agent's task: records the request, cancels the harness turn, and
   * acknowledges only once the agent actually reaches quiescence.
   *
   * The acknowledgement is deliberately deferred to `whenIdle()`. PRD 6.2
   * requires "cancel requested" and "execution stopped" to stay distinct, so
   * the task does not claim to be stopped while the agent is still winding
   * down.
   */
  async cancel(agent: Agent): Promise<Task | undefined> {
    const requested = this.#bindings.requestCancel(agent)
    if (requested === undefined) return undefined
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    return this.#bindings.acknowledgeCancel(agent)
  }

  async #gate(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined || !this.#bindings.isBound(agent)) return next()

    const decision = this.#bindings.gate(agent, {
      toolId: exec.name,
      path: extractPathArgument(exec.arguments, this.#pathKeys),
      requiresApproval: this.#approvalTools.has(exec.name),
      detail: { callId: exec.callId },
    })
    if (decision === undefined) return next()
    if (decision.kind !== 'require-approval') return toPreToolDecision(decision)

    const resolved = await this.#askApproval(exec, agent, decision.reason)
    const settled = this.#bindings.resolveApproval(agent, resolved.approved, resolved.reason)
    // `settled` is undefined only if the task was not actually waiting, which
    // would mean this layer lost track of its own state. Fail closed.
    return toPreToolDecision(settled ?? { kind: 'deny', reason: resolved.reason })
  }

  async #askApproval(
    exec: ToolExecution,
    agent: Agent,
    reason: string,
  ): Promise<ResolvedApproval> {
    try {
      const outcome = await this.ctx.approval.request({
        agent,
        toolName: exec.name,
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
      return approvalToResolved(outcome)
    } catch (error) {
      // The seam throws when asked outside an open turn. Treat any delivery
      // failure as a refusal: an approval that could not be asked is not given.
      return { approved: false, reason: `the approval request could not be delivered: ${messageOf(error)}` }
    }
  }

  #observe(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const agent = exec.agent
    if (agent === undefined || !this.#bindings.isBound(agent)) return
    this.#bindings.recordToolOutcome(agent, {
      callId: exec.callId,
      toolName: exec.name,
      result,
      testTools: [...this.#testTools],
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default PaimonTaskService
