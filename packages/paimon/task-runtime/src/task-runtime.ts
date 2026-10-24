import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { type Clock, systemClock, toIso } from './clock.ts'
import { ApprovalPendingError, TaskClosedError, TaskNotFoundError, taskError } from './errors.ts'
import { redactRecord } from './redaction.ts'
import { DEFAULT_RETRY_POLICY, decideRetry, type RetryPolicy } from './retry-policy.ts'
import { assertRunTransition, assertTaskTransition } from './state-machine.ts'
import { MemoryTaskStore, type TaskStore } from './store.ts'
import {
  isTerminalTaskStatus,
  outcomeOf,
  type Evidence,
  type Run,
  type Task,
  type TaskError,
  type TaskEvent,
  type TaskEventType,
  type TaskResult,
  type TerminalStatus,
  type ValidationReport,
  type ValidationRuleSpec,
} from './types.ts'
import { ResultValidator, ruleFromSpec, type ValidationRule } from './validator.ts'
import { checkWithinWorkspace } from './workspace.ts'

/** Construction options for a {@link TaskRuntime}. */
export interface TaskRuntimeOptions {
  readonly clock?: Clock | undefined
  readonly store?: TaskStore | undefined
  readonly idFactory?: (() => string) | undefined
  /** Fallback policy for tasks that do not carry their own. */
  readonly retryPolicy?: RetryPolicy | undefined
  /** Strings scrubbed from every recorded event. */
  readonly knownSecrets?: readonly string[] | undefined
}

/** What the caller must supply to create a task. */
export interface CreateTaskInput {
  readonly goal: string
  /** Absolute directory the task may touch. Omit to authorise no paths at all. */
  readonly workspace?: string | undefined
  /** Total wall-clock budget measured from the first run. */
  readonly deadlineMs?: number | undefined
  readonly retryPolicy?: RetryPolicy | undefined
  /** Completion conditions. An empty list can never validate. */
  readonly rules?: readonly ValidationRule[] | undefined
  /**
   * The same conditions as data.
   *
   * Supply this whenever the task may outlive the process: only specs can be
   * persisted, so a task created with closures alone becomes unverifiable the
   * moment it is reloaded.
   */
  readonly ruleSpecs?: readonly ValidationRuleSpec[] | undefined
}

/** A tool call the agent wants to perform, submitted for gating. */
export interface ToolGateRequest {
  readonly toolId: string
  /** File path the call touches, checked against the task workspace. */
  readonly path?: string | undefined
  /** Whether the operation needs a human decision before running. */
  readonly requiresApproval?: boolean | undefined
  /** Extra context recorded with the event; redacted before storage. */
  readonly detail?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The gate's answer.
 *
 * Mirrors the harness `PreToolDecision` vocabulary so an adapter can translate
 * one into the other without inventing a third set of names.
 */
export type ToolGateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'require-approval'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'timed-out'; readonly reason: string }

/** How a run settled. */
export type SettleOutcome =
  | { readonly kind: 'succeeded'; readonly task: Task; readonly run: Run; readonly report: ValidationReport }
  | {
    readonly kind: 'retry'
    readonly task: Task
    readonly run: Run
    readonly report: ValidationReport
    readonly nextAttempt: number
    readonly reason: string
  }
  | {
    readonly kind: 'failed'
    readonly task: Task
    readonly run: Run
    readonly report: ValidationReport
    readonly reason: string
  }

/** The two ways a failed run can resolve: another attempt, or a closed task. */
type RetryOutcome =
  | Extract<SettleOutcome, { kind: 'retry' }>
  | Extract<SettleOutcome, { kind: 'failed' }>

/** How a failed run was resolved. */
export interface FailureOutcome {
  readonly task: Task
  readonly run: Run
  readonly retried: boolean
  readonly reason: string
}

/**
 * Task governance layer.
 *
 * Owns exactly the four things the harness does not: a task that outlives a
 * turn, its terminal state machine, a bounded retry budget, and evidence-based
 * completion. It deliberately knows nothing about models, tools or the agent
 * loop; an adapter feeds it facts and asks it for decisions.
 */
export class TaskRuntime {
  readonly #clock: Clock
  readonly #store: TaskStore
  readonly #idFactory: () => string
  readonly #retryPolicy: RetryPolicy
  readonly #knownSecrets: readonly string[]
  readonly #rules = new Map<string, readonly ValidationRule[]>()
  readonly #policies = new Map<string, RetryPolicy>()

  constructor(options: TaskRuntimeOptions = {}) {
    this.#clock = options.clock ?? systemClock
    this.#store = options.store ?? new MemoryTaskStore()
    this.#idFactory = options.idFactory ?? randomUUID
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY
    this.#knownSecrets = options.knownSecrets ?? []
  }

  /** The store backing this runtime, exposed for query adapters. */
  get store(): TaskStore {
    return this.#store
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates a task in `PENDING` and records `task/created`. */
  createTask(input: CreateTaskInput): Task {
    // A zero or negative budget is not "unlimited", it is an instant timeout:
    // the deadline is compared against the moment the first run started, so
    // any elapsed millisecond closes the task before it can work. Rejecting it
    // keeps the two meanings from being confused at the only place that reads
    // the number.
    if (input.deadlineMs !== undefined && !(input.deadlineMs > 0)) {
      throw new RangeError('deadlineMs must be a positive number of milliseconds; omit it for no deadline')
    }
    const now = toIso(this.#clock)
    const task: Task = {
      id: this.#idFactory(),
      goal: input.goal,
      status: 'PENDING',
      workspace: input.workspace ?? undefined,
      deadlineMs: input.deadlineMs ?? undefined,
      createdAt: now,
      updatedAt: now,
      startedAt: undefined,
      cancelRequestedAt: undefined,
      cancelAcknowledgedAt: undefined,
      currentRunId: undefined,
      runIds: [],
      finalResult: undefined,
      ruleSpecs: input.ruleSpecs ?? [],
      ...input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy },
    }
    // Registered only when closures were actually supplied: an empty live set
    // would shadow the specs and make a task created from data unverifiable.
    if (input.rules !== undefined) {
      this.#rules.set(task.id, input.rules)
    }
    if (input.retryPolicy !== undefined) {
      this.#policies.set(task.id, input.retryPolicy)
    }
    this.#store.saveTask(task)
    this.#record(task, 'task/created', {
      goal: input.goal,
      workspace: task.workspace,
      deadlineMs: task.deadlineMs,
    })
    return task
  }

  /** Returns the current task snapshot, or throws when the id is unknown. */
  getTask(taskId: string): Task {
    return this.#requireTask(taskId)
  }

  /** Every task in the store, oldest first. */
  listTasks(): readonly Task[] {
    return this.#store.listTasks()
  }

  /** Runs for a task, ordered by attempt. */
  listRuns(taskId: string): readonly Run[] {
    this.#requireTask(taskId)
    return this.#store.listRuns(taskId)
  }

  /** Events for a task, in append order. */
  getEvents(taskId: string): readonly TaskEvent[] {
    this.#requireTask(taskId)
    return this.#store.listEvents({ taskId })
  }

  // ------------------------------------------------------------------- runs

  /**
   * Starts a new attempt, or throws when the task cannot run.
   *
   * Retrying is expressed as a second call to this method after a failed run
   * left the task in `RUNNING`; the previous run keeps its terminal status.
   */
  startRun(taskId: string): Run {
    const task = this.#requireTask(taskId)
    if (isTerminalTaskStatus(task.status)) throw new TaskClosedError(task.id, task.status)
    if (this.#deadlineExceeded(task)) {
      this.#expire(task)
      throw new TaskClosedError(task.id, task.status)
    }
    if (task.cancelRequestedAt !== undefined) {
      throw new Error(`task ${task.id} has a pending cancellation; no new run may start`)
    }
    // Checked before the active-run guard: when an approval is pending the run
    // is still active, and "waiting for an approval" is the useful reason.
    if (task.status === 'WAITING_APPROVAL') {
      throw new Error(`task ${task.id} is waiting for an approval decision`)
    }
    if (task.currentRunId !== undefined) {
      throw new Error(`task ${task.id} already has an active run ${task.currentRunId}`)
    }

    const now = toIso(this.#clock)
    if (task.status === 'PENDING') {
      assertTaskTransition(task.status, 'RUNNING')
      task.status = 'RUNNING'
      task.startedAt = now
      this.#record(task, 'task/status-changed', { from: 'PENDING', to: 'RUNNING' })
    }

    const run: Run = {
      id: this.#idFactory(),
      taskId: task.id,
      attempt: task.runIds.length + 1,
      status: 'RUNNING',
      startedAt: now,
      endedAt: undefined,
      error: undefined,
      resultSummary: undefined,
      timedOut: false,
    }
    this.#store.saveRun(run)
    task.runIds.push(run.id)
    task.currentRunId = run.id
    task.updatedAt = now
    this.#store.saveTask(task)
    this.#record(task, 'run/started', { attempt: run.attempt }, run.id)
    return run
  }

  // --------------------------------------------------------------- tool gate

  /**
   * Decides whether a tool call may proceed, and records the decision.
   *
   * Order matters and mirrors the harness pipeline: a closed task, then a
   * cancellation, then the deadline, then the workspace boundary, then
   * approval. Cancellation and deadline are checked before the boundary so a
   * stopped task reports *why it is stopped* rather than an incidental path
   * complaint.
   */
  gateToolCall(taskId: string, request: ToolGateRequest): ToolGateDecision {
    const task = this.#requireTask(taskId)
    this.#record(task, 'tool/requested', {
      toolId: request.toolId,
      path: request.path,
      requiresApproval: request.requiresApproval === true,
      ...(request.detail ?? {}),
    }, task.currentRunId)

    if (isTerminalTaskStatus(task.status)) {
      return this.#deny(task, request, `task is already ${task.status}`)
    }
    if (task.cancelRequestedAt !== undefined) {
      return this.#cancelDecision(task, request)
    }
    if (this.#deadlineExceeded(task)) {
      this.#expire(task)
      this.#record(task, 'tool/denied', { toolId: request.toolId, reason: 'deadline passed' }, task.currentRunId)
      return { kind: 'timed-out', reason: 'the task deadline passed before this call started' }
    }
    if (request.path !== undefined && task.workspace !== undefined) {
      // A relative path is relative to the workspace, not to whatever directory
      // the harness process happens to run in: resolving against the CWD would
      // check a boundary the model never meant to cross, and `resolve()` would
      // otherwise silently point outside the workspace.
      const candidate = isAbsolute(request.path) ? request.path : resolve(task.workspace, request.path)
      const boundary = checkWithinWorkspace(task.workspace, candidate)
      if (boundary.kind === 'deny') {
        return this.#deny(task, request, boundary.reason)
      }
    }
    if (request.path !== undefined && task.workspace === undefined) {
      return this.#deny(task, request, 'the task declares no workspace, so no path is authorised')
    }
    if (request.requiresApproval === true) {
      if (task.currentRunId === undefined) {
        return this.#deny(task, request, 'no active run, so there is nothing to approve')
      }
      if (task.status === 'RUNNING') {
        assertTaskTransition(task.status, 'WAITING_APPROVAL')
        task.status = 'WAITING_APPROVAL'
        task.updatedAt = toIso(this.#clock)
        this.#store.saveTask(task)
        this.#record(task, 'task/status-changed', { from: 'RUNNING', to: 'WAITING_APPROVAL' }, task.currentRunId)
      }
      this.#record(task, 'tool/approval-required', { toolId: request.toolId }, task.currentRunId)
      return { kind: 'require-approval', reason: 'the operation needs a human decision' }
    }

    this.#record(task, 'tool/allowed', { toolId: request.toolId }, task.currentRunId)
    return { kind: 'allow' }
  }

  /**
   * Records a human decision for a call that asked for approval.
   *
   * A rejection returns the task to `RUNNING` with the operation denied. It is
   * never retried automatically: PRD SEC-004 requires that a refusal cannot be
   * routed around, so the caller must surface the denial instead of looping.
   */
  resolveApproval(taskId: string, approved: boolean, reason?: string): ToolGateDecision {
    const task = this.#requireTask(taskId)
    if (task.status !== 'WAITING_APPROVAL') {
      throw new Error(`task ${task.id} is ${task.status}, not WAITING_APPROVAL`)
    }
    assertTaskTransition(task.status, 'RUNNING')
    task.status = 'RUNNING'
    task.updatedAt = toIso(this.#clock)
    this.#store.saveTask(task)
    this.#record(task, 'task/status-changed', { from: 'WAITING_APPROVAL', to: 'RUNNING' }, task.currentRunId)
    this.#record(task, 'tool/approval-decided', { approved, reason }, task.currentRunId)
    return approved
      ? { kind: 'allow' }
      : { kind: 'deny', reason: reason ?? 'the operation was rejected by the user' }
  }

  /** Records that an allowed tool call finished. */
  recordToolResult(taskId: string, toolId: string, ok: boolean, detail?: string): void {
    const task = this.#requireTask(taskId)
    this.#record(task, ok ? 'tool/executed' : 'tool/failed', { toolId, detail }, task.currentRunId)
  }

  // ----------------------------------------------------------------- settling

  /**
   * Evaluates the completion conditions without settling the run.
   *
   * Exists so a caller can ask "would this pass?" and keep working when the
   * answer is no. Without it, the only way to find out is to settle, and a
   * failing settlement closes the run — a coding agent that checks too early
   * would kill its own task.
   *
   * @throws ApprovalPendingError while a human decision is outstanding.
   */
  checkCompletion(taskId: string, evidence: readonly Evidence[]): ValidationReport {
    const task = this.#requireTask(taskId)
    if (task.status === 'WAITING_APPROVAL') throw new ApprovalPendingError(task.id)
    return new ResultValidator(this.#rulesFor(task)).validate(evidence)
  }

  /**
   * Settles the active run by validating the evidence it produced.
   *
   * A passing report ends the task as `SUCCEEDED`. A failing report ends the
   * *run* as `FAILED` and then asks the retry policy what happens to the task:
   * another attempt keeps it `RUNNING`, an exhausted budget makes it `FAILED`.
   */
  completeRun(taskId: string, evidence: readonly Evidence[], summary: string): SettleOutcome {
    const task = this.#requireTask(taskId)
    // The deadline is checked here as well as at every gate: work can finish
    // *after* the budget is spent, and settling that as success would let a task
    // buy its own way out of the limit it was given.
    if (this.#deadlineExceeded(task)) {
      const report = new ResultValidator(this.#rulesFor(task)).validate(evidence)
      const lastRunId = task.runIds.at(-1)
      this.#expire(task)
      const expired = lastRunId === undefined ? undefined : this.#store.getRun(lastRunId)
      if (expired === undefined) throw new TaskClosedError(task.id, task.status)
      return {
        kind: 'failed',
        task,
        run: expired,
        report,
        reason: 'the task deadline passed before this attempt settled',
      }
    }
    const run = this.#requireActiveRun(task)
    const report = new ResultValidator(this.#rulesFor(task)).validate(evidence)
    this.#record(task, 'validation/completed', {
      satisfied: report.satisfied,
      checks: report.checks.map(check => ({
        id: check.id,
        outcome: check.outcome,
        note: check.note,
      })),
    }, run.id)

    if (report.satisfied) {
      // Finish the run first: a task may only close after the attempt that
      // justified it is itself settled.
      const succeededRun = this.#finishRun(run, 'SUCCEEDED', undefined, summary)
      return {
        kind: 'succeeded',
        task: this.#finishTask(task, 'SUCCEEDED', summary, report),
        run: succeededRun,
        report,
      }
    }

    const error = taskError('validation', 'the completion conditions were not satisfied', describeReport(report))
    const failedRun = this.#finishRun(run, 'FAILED', error, summary)
    return this.#applyRetry(task, failedRun, report, error, summary)
  }

  /**
   * Settles the active run as a failure reported by an executor.
   *
   * The error kind decides the task status when no retry happens: `cancelled`
   * becomes `CANCELLED`, `timeout` becomes `TIMED_OUT`, everything else
   * `FAILED`. A cancellation request already on record always wins, which is
   * how PRD SEC-004 is enforced structurally rather than by convention.
   */
  failRun(taskId: string, error: TaskError, summary?: string): FailureOutcome {
    const task = this.#requireTask(taskId)
    const run = this.#requireActiveRun(task)
    const runStatus = error.kind === 'cancelled'
      ? 'CANCELLED'
      : error.kind === 'timeout' ? 'TIMED_OUT' : 'FAILED'
    const finishedRun = this.#finishRun(run, runStatus, error, summary ?? error.message)
    const report = new ResultValidator(this.#rulesFor(task)).validate([])
    const settled = this.#applyRetry(task, finishedRun, report, error, summary ?? error.message)
    return {
      task: settled.task,
      run: finishedRun,
      retried: settled.kind === 'retry',
      reason: settled.reason,
    }
  }

  // -------------------------------------------------------------- cancel/time

  /**
   * Records the user's intent to stop, without claiming execution stopped.
   *
   * Idempotent: a second request while one is pending adds no event, and a
   * request against a finished task is a no-op rather than an error, because a
   * late click should not fail.
   */
  requestCancel(taskId: string): Task {
    const task = this.#requireTask(taskId)
    if (isTerminalTaskStatus(task.status)) return task
    if (task.cancelRequestedAt !== undefined) return task
    task.cancelRequestedAt = toIso(this.#clock)
    task.updatedAt = task.cancelRequestedAt
    this.#store.saveTask(task)
    this.#record(task, 'task/cancel-requested', { status: task.status }, task.currentRunId)
    return task
  }

  /**
   * Records that execution actually stopped and closes the task as `CANCELLED`.
   *
   * Separate from {@link requestCancel} on purpose: PRD 6.2 requires the
   * difference between "cancel requested" and "execution stopped" to be
   * observable, so only this method moves the status.
   */
  acknowledgeCancel(taskId: string): Task {
    const task = this.#requireTask(taskId)
    if (task.cancelRequestedAt === undefined) {
      throw new Error(`task ${task.id} has no pending cancellation to acknowledge`)
    }
    if (isTerminalTaskStatus(task.status)) return task

    const now = toIso(this.#clock)
    assertTaskTransition(task.status, 'CANCELLED')
    if (task.currentRunId !== undefined) {
      const run = this.#store.getRun(task.currentRunId)
      if (run !== undefined && run.status === 'RUNNING') {
        assertRunTransition(run.status, 'CANCELLED')
        this.#finishRun(run, 'CANCELLED', taskError('cancelled', 'the user cancelled the task'), 'cancelled by user')
      }
    }
    task.cancelAcknowledgedAt = now
    this.#record(task, 'task/cancel-acknowledged', { requestedAt: task.cancelRequestedAt }, task.currentRunId)
    return this.#finishTask(task, 'CANCELLED', 'cancelled by user', undefined)
  }

  /**
   * Closes the task as `TIMED_OUT` if its budget is spent.
   *
   * Returns whether the deadline fired. Callers invoke this at every decision
   * boundary so a task cannot start new work after its budget ran out, which is
   * the guarantee a cooperative per-tool timeout cannot provide.
   */
  enforceDeadline(taskId: string): boolean {
    const task = this.#requireTask(taskId)
    if (isTerminalTaskStatus(task.status)) return false
    if (!this.#deadlineExceeded(task)) return false
    this.#expire(task)
    return true
  }

  /**
   * Closes a task nobody is going to finish, as `FAILED`.
   *
   * A cancellation needs someone still driving the work and a deadline needs a
   * budget; a task that has neither (no `deadlineMs`, or one restored from disk
   * by a process that no longer holds the agent that created it) would sit in
   * `RUNNING` forever and accumulate as a zombie. Abandoning is an explicit,
   * recorded act instead of a timeout, so the timeline says who gave up and why.
   *
   * Idempotent against a finished task: a late abandon is a no-op, not an error.
   */
  abandon(taskId: string, reason: string): Task {
    const task = this.#requireTask(taskId)
    if (isTerminalTaskStatus(task.status)) return task
    this.#record(task, 'task/abandoned', { reason, status: task.status })
    const error = taskError('abandoned', reason)
    if (task.currentRunId !== undefined) {
      const run = this.#store.getRun(task.currentRunId)
      if (run !== undefined && run.status === 'RUNNING') {
        this.#finishRun(run, 'FAILED', error, reason)
        this.#record(task, 'run/ended', { attempt: run.attempt, status: 'FAILED', reason }, run.id)
      }
    }
    return this.#finishTask(task, 'FAILED', reason, undefined)
  }

  // ------------------------------------------------------------------ private

  /**
   * Completion rules for a task: the live set if this process registered one,
   * otherwise the specs persisted with the task.
   *
   * The fallback is what keeps a restarted task verifiable. It is a fallback
   * rather than the only source because a caller may legitimately hand over a
   * closure a spec cannot express.
   */
  #rulesFor(task: Task): readonly ValidationRule[] {
    const live = this.#rules.get(task.id)
    if (live !== undefined) return live
    return (task.ruleSpecs ?? []).map(ruleFromSpec)
  }

  /** Retry policy for a task: live override, then the task's own, then the default. */
  #policyFor(task: Task): RetryPolicy {
    return this.#policies.get(task.id) ?? task.retryPolicy ?? this.#retryPolicy
  }

  #applyRetry(
    task: Task,
    run: Run,
    report: ValidationReport,
    error: TaskError,
    summary: string,
  ): RetryOutcome {
    if (task.cancelRequestedAt !== undefined) {
      this.#record(task, 'run/ended', { attempt: run.attempt, status: run.status }, run.id)
      return {
        kind: 'failed',
        task: this.#finishTask(task, 'CANCELLED', 'cancelled by user', report),
        run,
        report,
        reason: 'a cancellation request is on record; no retry may follow',
      }
    }

    const decision = decideRetry({
      attempt: run.attempt,
      error,
      cancelled: task.cancelRequestedAt !== undefined,
      deadlineExceeded: this.#deadlineExceeded(task),
      policy: this.#policyFor(task),
    })
    this.#record(task, 'run/ended', { attempt: run.attempt, status: run.status, retry: decision.kind }, run.id)

    if (decision.kind === 'retry') {
      task.currentRunId = undefined
      task.updatedAt = toIso(this.#clock)
      this.#store.saveTask(task)
      return { kind: 'retry', task, run, report, nextAttempt: decision.nextAttempt, reason: decision.reason }
    }

    const terminal: TerminalStatus = error.kind === 'cancelled'
      ? 'CANCELLED'
      : error.kind === 'timeout' ? 'TIMED_OUT' : 'FAILED'
    return {
      kind: 'failed',
      task: this.#finishTask(task, terminal, summary, report),
      run,
      report,
      reason: decision.reason,
    }
  }

  #finishRun(run: Run, status: TerminalStatus, error: TaskError | undefined, summary: string): Run {
    assertRunTransition(run.status, status)
    run.status = status
    run.endedAt = toIso(this.#clock)
    run.error = error
    run.resultSummary = summary
    run.timedOut = status === 'TIMED_OUT'
    this.#store.saveRun(run)
    return run
  }

  #finishTask(
    task: Task,
    status: TerminalStatus,
    summary: string,
    report: ValidationReport | undefined,
  ): Task {
    assertTaskTransition(task.status, status)
    const previous = task.status
    task.status = status
    task.updatedAt = toIso(this.#clock)
    task.currentRunId = undefined
    const result: TaskResult = {
      outcome: outcomeOf(status),
      summary,
      validation: report,
      runId: task.runIds.at(-1) ?? undefined,
    }
    task.finalResult = result
    this.#store.saveTask(task)
    this.#record(task, 'task/status-changed', { from: previous, to: status, outcome: result.outcome })
    // A finished task never validates or retries again, so its per-task
    // configuration must not outlive it in a long-running process.
    this.#rules.delete(task.id)
    this.#policies.delete(task.id)
    return task
  }

  #expire(task: Task): void {
    const now = toIso(this.#clock)
    if (task.currentRunId !== undefined) {
      const run = this.#store.getRun(task.currentRunId)
      if (run !== undefined && run.status === 'RUNNING') {
        this.#finishRun(run, 'TIMED_OUT', taskError('timeout', 'the task deadline passed'), 'timed out')
        this.#record(task, 'run/ended', { attempt: run.attempt, status: 'TIMED_OUT' }, run.id)
      }
    }
    task.updatedAt = now
    this.#finishTask(task, 'TIMED_OUT', 'the task deadline passed', undefined)
  }

  #deadlineExceeded(task: Task): boolean {
    if (task.deadlineMs === undefined || task.startedAt === undefined) return false
    const startedAtMs = Date.parse(task.startedAt)
    return this.#clock.now() > startedAtMs + task.deadlineMs
  }

  #deny(task: Task, request: ToolGateRequest, reason: string): ToolGateDecision {
    this.#record(task, 'tool/denied', { toolId: request.toolId, reason }, task.currentRunId)
    return { kind: 'deny', reason }
  }

  #cancelDecision(task: Task, request: ToolGateRequest): ToolGateDecision {
    const reason = 'the user asked to cancel this task'
    this.#record(task, 'tool/denied', { toolId: request.toolId, reason }, task.currentRunId)
    return { kind: 'cancelled', reason }
  }

  #requireTask(taskId: string): Task {
    const task = this.#store.getTask(taskId)
    if (task === undefined) throw new TaskNotFoundError(taskId)
    return task
  }

  #requireActiveRun(task: Task): Run {
    if (task.status === 'WAITING_APPROVAL') {
      // The flow is paused for a human decision; a run cannot settle yet.
      throw new ApprovalPendingError(task.id)
    }
    if (task.currentRunId === undefined) {
      throw new Error(`task ${task.id} has no active run`)
    }
    const run = this.#store.getRun(task.currentRunId)
    if (run === undefined) throw new Error(`run ${task.currentRunId} is missing from the store`)
    if (run.status !== 'RUNNING') {
      throw new Error(`run ${run.id} is already ${run.status}`)
    }
    return run
  }

  #record(
    task: Task,
    type: TaskEventType,
    data: Readonly<Record<string, unknown>>,
    runId?: string,
  ): void {
    const event: TaskEvent = {
      id: this.#idFactory(),
      taskId: task.id,
      runId: runId ?? task.currentRunId,
      type,
      timestamp: toIso(this.#clock),
      data: redactRecord(data, this.#knownSecrets),
    }
    this.#store.appendEvent(event)
  }
}

function describeReport(report: ValidationReport): string {
  const failed = report.checks.filter(check => check.outcome !== 'passed')
  if (failed.length === 0) return 'no completion conditions were configured'
  return failed
    .map(check => `${check.id}: ${check.outcome}${check.note === undefined ? '' : ` (${check.note})`}`)
    .join('; ')
}
