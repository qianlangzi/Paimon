/**
 * Paimon task governance layer.
 *
 * The harness already owns the agent loop, the tool pipeline, the approval
 * seam, the sandbox and the session log. What it does not own is a *task*: a
 * user goal that outlives a turn, ends in a verified terminal state, and can be
 * retried a bounded number of times. This package supplies exactly that and
 * nothing else.
 *
 * Everything here is free of DSH and Cordis imports on purpose, so the domain
 * rules can be tested without booting a harness and cannot accidentally depend
 * on harness internals.
 */

export {
  type Clock,
  type ManualClock,
  createManualClock,
  systemClock,
  toIso,
} from './clock.ts'

export {
  InvalidTransitionError,
  TaskClosedError,
  TaskNotFoundError,
  taskError,
} from './errors.ts'

export {
  DEFAULT_RETRY_POLICY,
  type RetryContext,
  type RetryDecision,
  type RetryPolicy,
  decideRetry,
} from './retry-policy.ts'

export {
  REDACTED,
  isSecretKey,
  redact,
  redactRecord,
  scrubText,
} from './redaction.ts'

export {
  assertRunTransition,
  assertTaskTransition,
  canTransitionRun,
  canTransitionTask,
  runTargets,
  taskTargets,
} from './state-machine.ts'

export {
  MemoryTaskStore,
  type TaskStore,
} from './store.ts'

export {
  type CreateTaskInput,
  type FailureOutcome,
  type SettleOutcome,
  TaskRuntime,
  type TaskRuntimeOptions,
  type ToolGateDecision,
  type ToolGateRequest,
} from './task-runtime.ts'

export {
  RUN_TERMINAL_STATUSES,
  TASK_EVENT_TYPES,
  TASK_TERMINAL_STATUSES,
  type CheckOutcome,
  type EventFilter,
  type Evidence,
  type EvidenceKind,
  type Run,
  type RunStatus,
  type Task,
  type TaskError,
  type TaskErrorKind,
  type TaskEvent,
  type TaskEventType,
  type TaskOutcome,
  type TaskResult,
  type TaskStatus,
  type TerminalStatus,
  type ValidationCheck,
  type ValidationReport,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  outcomeOf,
} from './types.ts'

export {
  AUTHORITATIVE_EVIDENCE_KINDS,
  ResultValidator,
  type ValidationRule,
  authoritativeOnly,
  commandExitRule,
  customRule,
  fileStateRule,
  isAuthoritative,
  testReportRule,
} from './validator.ts'

export {
  type BoundaryDecision,
  checkWithinWorkspace,
} from './workspace.ts'
