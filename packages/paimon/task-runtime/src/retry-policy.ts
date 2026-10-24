import type { RetryPolicy, TaskError } from './types.ts'

/**
 * The retry policy shape is part of the task aggregate, so it is declared in
 * `types.ts` with the rest of the durable model and re-exported here, where
 * every existing caller looks for it.
 */
export type { RetryPolicy } from './types.ts'

/**
 * Default policy: three attempts, retrying only failures that another attempt
 * could plausibly change.
 *
 * `permission` is excluded because a denial is a decision, not a transient
 * fault. `cancelled` and `timeout` are excluded because the budget they would
 * spend no longer exists. `validation` is excluded because re-running the same
 * work without new information reproduces the same failure; a caller that has
 * new information should start a new run explicitly.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  retryableKinds: ['model', 'tool', 'internal'],
}

/** Inputs that decide whether one more attempt is allowed. */
export interface RetryContext {
  /** The attempt that just failed, 1-based. */
  readonly attempt: number
  readonly error: TaskError
  /** True once the user asked to stop, regardless of acknowledgement. */
  readonly cancelled: boolean
  /** True once the task deadline passed. */
  readonly deadlineExceeded: boolean
  /** Optional override used when a task carries its own policy. */
  readonly policy?: RetryPolicy
}

/** The decision, with the reason kept for the event log. */
export type RetryDecision =
  | { readonly kind: 'retry'; readonly reason: string; readonly nextAttempt: number }
  | { readonly kind: 'stop'; readonly reason: string }

/**
 * Decides whether another attempt is allowed.
 *
 * Evaluation order is deliberate and is the security-relevant part: a
 * cancellation wins over every other consideration, so no retry path can route
 * around a user's stop. A passed deadline wins next, because starting work with
 * no budget left would misreport progress. Only then do error class and attempt
 * budget matter.
 */
export function decideRetry(context: RetryContext): RetryDecision {
  const policy = context.policy ?? DEFAULT_RETRY_POLICY

  if (context.cancelled) {
    return { kind: 'stop', reason: 'the task was cancelled; a cancellation is never retried' }
  }
  if (context.deadlineExceeded) {
    return { kind: 'stop', reason: 'the task deadline passed; no budget remains for another attempt' }
  }
  if (!policy.retryableKinds.includes(context.error.kind)) {
    return {
      kind: 'stop',
      reason: `failure kind "${context.error.kind}" is not retryable under this policy`,
    }
  }
  if (context.attempt >= policy.maxAttempts) {
    return {
      kind: 'stop',
      reason: `attempt budget exhausted (${context.attempt}/${policy.maxAttempts})`,
    }
  }
  return {
    kind: 'retry',
    reason: `failure kind "${context.error.kind}" is retryable and budget remains (${context.attempt}/${policy.maxAttempts})`,
    nextAttempt: context.attempt + 1,
  }
}
