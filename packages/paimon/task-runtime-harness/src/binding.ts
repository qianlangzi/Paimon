import type {
  CreateTaskInput,
  Evidence,
  Task,
  TaskRuntime,
  ToolGateDecision,
  ToolGateRequest,
} from '@deepseek-ai/dsh-paimon-task-runtime'
import { isTerminalTaskStatus } from '@deepseek-ai/dsh-paimon-task-runtime'
import { type EvidenceInput, extractEvidence } from './evidence.ts'

/**
 * The only part of a harness agent this layer needs.
 *
 * Structural rather than an import of the harness `Agent`, so bindings can be
 * unit-tested against plain objects and the adapter cannot grow a dependency
 * on agent internals just because they were in scope.
 */
export interface AgentRef {
  readonly id: string
}

/** One agent-to-task association. */
export interface TaskBinding {
  readonly agentId: string
  readonly taskId: string
}

/**
 * Associates harness agents with Paimon tasks and routes decisions through the
 * runtime.
 *
 * The central safety property is that an **unbound agent is untouched**: every
 * routing method returns `undefined` when no task is bound, and the caller
 * must delegate unchanged. An adapter that silently invented a task for every
 * session would change harness behaviour for users who never asked for it.
 */
export class TaskBindings {
  readonly #runtime: TaskRuntime
  readonly #taskByAgent = new Map<string, string>()
  readonly #evidenceByTask = new Map<string, Evidence[]>()

  constructor(runtime: TaskRuntime) {
    this.#runtime = runtime
  }

  /** The governance runtime these bindings drive. */
  get runtime(): TaskRuntime {
    return this.#runtime
  }

  /**
   * Creates a task and binds it to an agent.
   *
   * A *live* task cannot be replaced: rebinding would orphan the first task
   * with a live run, so it is refused rather than silently swapped. A task that
   * has already finished no longer governs the session, so it does not hold the
   * slot either — otherwise one finished task would make every later request in
   * the same session fail with "already bound".
   */
  bind(agent: AgentRef, input: CreateTaskInput): Task {
    const existing = this.#taskByAgent.get(agent.id)
    if (existing !== undefined) {
      if (!isTerminalTaskStatus(this.#runtime.getTask(existing).status)) {
        throw new Error(`agent ${agent.id} is already bound to a task`)
      }
      this.#taskByAgent.delete(agent.id)
      this.#evidenceByTask.delete(existing)
    }
    const task = this.#runtime.createTask(input)
    this.#taskByAgent.set(agent.id, task.id)
    this.#evidenceByTask.set(task.id, [])
    return task
  }

  /** The bound task id, or `undefined` when this agent is unmanaged. */
  taskIdOf(agent: AgentRef): string | undefined {
    return this.#taskByAgent.get(agent.id)
  }

  /** The bound task snapshot, or `undefined` when this agent is unmanaged. */
  taskOf(agent: AgentRef): Task | undefined {
    const taskId = this.#taskByAgent.get(agent.id)
    return taskId === undefined ? undefined : this.#runtime.getTask(taskId)
  }

  /** Whether this agent has a task. */
  isBound(agent: AgentRef): boolean {
    return this.#taskByAgent.has(agent.id)
  }

  /** Every live association. */
  listBindings(): readonly TaskBinding[] {
    return [...this.#taskByAgent].map(([agentId, taskId]) => ({ agentId, taskId }))
  }

  /**
   * Gates one tool call.
   *
   * @returns `undefined` when the agent is unmanaged **or its task already
   * finished**, meaning "no opinion — delegate unchanged". A finished task
   * stops governing the session, so the agent can keep using tools for
   * whatever the user asks next instead of being locked out by a closed task.
   * A defined decision is authoritative.
   */
  gate(agent: AgentRef, request: ToolGateRequest): ToolGateDecision | undefined {
    const taskId = this.#taskByAgent.get(agent.id)
    if (taskId === undefined) return undefined
    if (isTerminalTaskStatus(this.#runtime.getTask(taskId).status)) return undefined
    return this.#runtime.gateToolCall(taskId, request)
  }

  /**
   * Records a human approval decision and returns the resulting gate decision.
   *
   * @returns `undefined` when the agent is unmanaged or its task is not
   * actually waiting for a decision, so the caller keeps the harness's own
   * behaviour instead of guessing.
   */
  resolveApproval(agent: AgentRef, approved: boolean, reason?: string): ToolGateDecision | undefined {
    const taskId = this.#taskByAgent.get(agent.id)
    if (taskId === undefined) return undefined
    if (this.#runtime.getTask(taskId).status !== 'WAITING_APPROVAL') return undefined
    return this.#runtime.resolveApproval(taskId, approved, reason)
  }

  /**
   * Records a tool outcome and appends the evidence it produced.
   *
   * @returns the evidence added, so a caller can log or inspect it; empty when
   * the agent is unmanaged or its task already finished (a closed task takes
   * no further evidence).
   */
  recordToolOutcome(agent: AgentRef, input: EvidenceInput): readonly Evidence[] {
    const taskId = this.#taskByAgent.get(agent.id)
    if (taskId === undefined) return []
    if (isTerminalTaskStatus(this.#runtime.getTask(taskId).status)) return []
    const evidence = extractEvidence(input)
    this.#evidenceByTask.get(taskId)?.push(...evidence)
    this.#runtime.recordToolResult(
      taskId,
      input.toolName,
      input.result.isError !== true,
      evidence[0]?.detail,
    )
    return evidence
  }

  /** Evidence accumulated for the agent's task, in arrival order. */
  evidenceOf(agent: AgentRef): readonly Evidence[] {
    const taskId = this.#taskByAgent.get(agent.id)
    return taskId === undefined ? [] : this.#evidenceByTask.get(taskId) ?? []
  }

  /** Records the user's intent to stop. Does not itself stop execution. */
  requestCancel(agent: AgentRef): Task | undefined {
    const taskId = this.#taskByAgent.get(agent.id)
    return taskId === undefined ? undefined : this.#runtime.requestCancel(taskId)
  }

  /** Records that execution actually stopped. */
  acknowledgeCancel(agent: AgentRef): Task | undefined {
    const taskId = this.#taskByAgent.get(agent.id)
    if (taskId === undefined) return undefined
    return this.#runtime.acknowledgeCancel(taskId)
  }

  /**
   * Drops every association pointing at a task, without touching the task.
   *
   * Used after a task is closed by something other than the agent that owns
   * it — an abandon from another session, for instance — so the agent is not
   * left bound to a finished task it can no longer influence.
   *
   * @returns how many associations were removed.
   */
  forget(taskId: string): number {
    let removed = 0
    for (const [agentId, boundTaskId] of this.#taskByAgent) {
      if (boundTaskId === taskId) {
        this.#taskByAgent.delete(agentId)
        removed += 1
      }
    }
    this.#evidenceByTask.delete(taskId)
    return removed
  }

  /**
   * Drops the association.
   *
   * @returns whether a binding existed. The task itself is left alone: a
   * caller that wants it cancelled calls {@link requestCancel} first, so
   * cleanup never cancels work the user did not ask to stop.
   */
  unbind(agent: AgentRef): boolean {
    const taskId = this.#taskByAgent.get(agent.id)
    if (taskId === undefined) return false
    this.#taskByAgent.delete(agent.id)
    this.#evidenceByTask.delete(taskId)
    return true
  }
}
