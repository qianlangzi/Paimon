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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  TaskRuntime,
  type CreateTaskInput,
  type Run,
  type Task,
  type TaskEvent,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import { FileTaskStore } from '@deepseek-ai/dsh-paimon-task-store-file'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { TaskBindings, type AgentRef } from './binding.ts'
import { type ResolvedApproval, approvalToResolved, toPreToolDecision } from './mapping.ts'
import { DEFAULT_PATH_ARGUMENT_KEYS, extractPathArgument } from './path-args.ts'

// The adapter's pieces are useful on their own: other plugins query bindings,
// tests drive them without a context, and an embedder may want the pure
// mapping helpers. Re-exporting keeps a single import path.
export { TaskBindings, type AgentRef, type TaskBinding } from './binding.ts'
export { type ToolResultLike, type EvidenceInput, extractEvidence } from './evidence.ts'
export { type ResolvedApproval, approvalToResolved, toPreToolDecision } from './mapping.ts'
export { DEFAULT_PATH_ARGUMENT_KEYS, extractPathArgument } from './path-args.ts'

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
  /**
   * Keep tasks under `$DSH_HOME/paimon/tasks` instead of in memory.
   *
   * Off by default on purpose: a test or an embedded use that constructs this
   * service must never write into the developer's real harness home.
   */
  readonly persist?: boolean
  /** Strings scrubbed from every recorded task event. */
  readonly knownSecrets?: string[]
}

/**
 * Everything a task detail surface needs, assembled in one call.
 *
 * The status tool asks the same three questions in a different order and for a
 * different reader; a desktop view needs the whole aggregate at once, and doing
 * that in the adapter keeps the view from depending on the runtime's shape.
 */
export interface TaskDetail {
  readonly task: Task
  readonly runs: readonly Run[]
  /** Oldest first, so a timeline can be rendered without reversing it. */
  readonly events: readonly TaskEvent[]
}

/** What a caller supplies when binding a task to an agent. */
export interface BindInput {
  readonly goal: string
  readonly workspace?: string | undefined
  readonly deadlineMs?: number | undefined
  readonly rules?: CreateTaskInput['rules']
  /** The same conditions as data, so the task stays verifiable after a restart. */
  readonly ruleSpecs?: CreateTaskInput['ruleSpecs']
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
    persist: z.boolean().default(false),
    knownSecrets: z.array(z.string()).default([]),
  })

  // Cordis wraps a Service in a Proxy, so ECMAScript private fields (`#x`)
  // cannot be read through it: the proxy receiver is not the instance that
  // declared them. TypeScript `private` compiles to ordinary properties and
  // survives the proxy, which is why every service in this repository uses it.
  private readonly taskBindings: TaskBindings
  private readonly approvalTools: ReadonlySet<string>
  private readonly testToolNames: ReadonlySet<string>
  private readonly pathKeys: readonly string[]
  private readonly defaultDeadlineMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'paimonTasks')
    this.approvalTools = new Set(config.approvalTools ?? [])
    this.testToolNames = new Set(config.testTools ?? [])
    this.pathKeys = config.pathArgumentKeys ?? DEFAULT_PATH_ARGUMENT_KEYS
    this.defaultDeadlineMs = config.deadlineMs ?? 0
    const store = config.persist === true
      ? new FileTaskStore({ directory: join(resolveDshHome(), 'paimon', 'tasks') })
      : undefined
    this.taskBindings = new TaskBindings(new TaskRuntime({
      knownSecrets: config.knownSecrets ?? [],
      store,
    }))

    this.ctx.on('tools/pre-execute', async (exec, next) => this.gateCall(exec, next))
    this.ctx.on('tools/result', (exec, result) => { this.observe(exec, result) })
  }

  /** The governance runtime, for queries and completion. */
  get runtime(): TaskRuntime {
    return this.taskBindings.runtime
  }

  /** The agent-to-task associations this adapter manages. */
  get bindings(): TaskBindings {
    return this.taskBindings
  }

  /**
   * Tool names whose success counts as "the tests passed".
   *
   * Read by the model-facing tools so a completion policy can be chosen from
   * what this deployment can actually verify, rather than from what the PRD
   * would like it to verify.
   */
  get testTools(): readonly string[] {
    return [...this.testToolNames]
  }

  /**
   * Creates a task and binds it to an agent.
   *
   * Applies the configured deadline when the caller does not supply one; a
   * configured value of `0` means "no default budget".
   */
  bind(agent: AgentRef, input: BindInput): Task {
    const deadlineMs = input.deadlineMs
      ?? (this.defaultDeadlineMs > 0 ? this.defaultDeadlineMs : undefined)
    return this.taskBindings.bind(agent, {
      goal: input.goal,
      workspace: input.workspace,
      deadlineMs,
      rules: input.rules,
      // Passed through explicitly: the adapter has no other chance to do it, and
      // dropping this silently leaves the task with no completion conditions —
      // which the model cannot tell apart from "the work is not done yet".
      ruleSpecs: input.ruleSpecs,
      retryPolicy: input.retryPolicy,
    })
  }

  /** The task bound to this agent, if any. */
  taskOf(agent: AgentRef): Task | undefined {
    return this.taskBindings.taskOf(agent)
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
    const requested = this.taskBindings.requestCancel(agent)
    if (requested === undefined) return undefined
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    return this.taskBindings.acknowledgeCancel(agent)
  }

  /**
   * Closes a task that nobody will finish, and drops the association with it.
   *
   * Distinct from {@link cancel}: cancelling means "stop what is running",
   * which needs a live agent to wind down. Abandoning means "this goal is
   * dropped", which is the only way to close a task a previous process left in
   * `RUNNING` — there is no agent left to cancel and, without a deadline, no
   * timer to expire it either.
   */
  abandon(taskId: string, reason: string): Task {
    const task = this.taskBindings.runtime.abandon(taskId, reason)
    this.taskBindings.forget(taskId)
    return task
  }

  /**
   * Every recorded task, oldest first.
   *
   * The first read model the desktop surfaces need: a task list is the entry
   * point for the detail, approval and diagnostics views, and it has to work
   * for tasks this process did not create (persisted history) as well as live
   * ones.
   */
  listTasks(): readonly Task[] {
    return this.runtime.listTasks()
  }

  /**
   * One task with its runs and timeline.
   *
   * @param eventLimit - Keep only the most recent N events. A long task can
   * accumulate thousands and a view that asks for the tail should not pay for
   * the whole log.
   */
  taskDetail(taskId: string, eventLimit?: number): TaskDetail {
    const task = this.runtime.getTask(taskId)
    const events = this.runtime.getEvents(taskId)
    return {
      task,
      runs: this.runtime.listRuns(taskId),
      events: eventLimit === undefined ? events : events.slice(-Math.max(0, eventLimit)),
    }
  }

  private async gateCall(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined || !this.taskBindings.isBound(agent)) return next()

    const decision = this.taskBindings.gate(agent, {
      toolId: exec.name,
      path: extractPathArgument(exec.arguments, this.pathKeys),
      requiresApproval: this.approvalTools.has(exec.name),
      detail: { callId: exec.callId },
    })
    if (decision === undefined) return next()
    if (decision.kind !== 'require-approval') return toPreToolDecision(decision)

    const resolved = await this.askApproval(exec, agent, decision.reason)
    const settled = this.taskBindings.resolveApproval(agent, resolved.approved, resolved.reason)
    // `settled` is undefined only if the task was not actually waiting, which
    // would mean this layer lost track of its own state. Fail closed.
    return toPreToolDecision(settled ?? { kind: 'deny', reason: resolved.reason })
  }

  private async askApproval(
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

  private observe(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const agent = exec.agent
    if (agent === undefined || !this.taskBindings.isBound(agent)) return
    this.taskBindings.recordToolOutcome(agent, {
      callId: exec.callId,
      toolName: exec.name,
      result,
      testTools: [...this.testToolNames],
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default PaimonTaskService
