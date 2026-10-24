import type { ToolGateDecision } from '@deepseek-ai/dsh-paimon-task-runtime'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

/**
 * Translates a Paimon gate decision into the harness pipeline vocabulary.
 *
 * The two vocabularies were designed independently and turn out to be almost
 * the same shape, which is why the adapter stays thin:
 *
 * | Paimon           | harness `PreToolDecision` |
 * | ---------------- | ------------------------- |
 * | `allow`          | `allow`                   |
 * | `deny`           | `deny`                    |
 * | `require-approval` | `ask`                   |
 * | `cancelled`      | `cancel`                  |
 * | `timed-out`      | `deny` (with the reason)  |
 *
 * A deadline is mapped to `deny` rather than `cancel` on purpose: `cancel`
 * selects the harness's canonical pre-dispatch cancellation result, which
 * reads to the model as "the caller stopped this", whereas a spent budget is a
 * refusal the model should see explained.
 */
export function toPreToolDecision(decision: ToolGateDecision): PreToolDecision {
  switch (decision.kind) {
    case 'allow':
      return { kind: 'allow' }
    case 'deny':
      return { kind: 'deny', reason: decision.reason }
    case 'require-approval':
      return { kind: 'ask', reason: decision.reason }
    case 'cancelled':
      return { kind: 'cancel' }
    case 'timed-out':
      return { kind: 'deny', reason: decision.reason }
  }
  // Unreachable for a typed caller. An untyped caller passing an unknown kind
  // must still fail closed rather than let the call proceed by returning
  // `undefined` into the pipeline.
  return { kind: 'deny', reason: `unrecognised gate decision "${String((decision as { readonly kind?: unknown }).kind)}"` }
}

/** The task-level meaning of an approval outcome. */
export interface ResolvedApproval {
  readonly approved: boolean
  readonly reason: string
}

/**
 * Collapses the harness's four approval outcomes into approve/refuse.
 *
 * Three of the four are refusals, and that asymmetry is the point: the seam is
 * fail-closed, so `cancelled` and `unavailable` must never be read as consent.
 * `allowed-once` is the only grant, and it covers exactly one request.
 */
export function approvalToResolved(outcome: ApprovalOutcome): ResolvedApproval {
  switch (outcome) {
    case 'allowed-once':
      return { approved: true, reason: 'approved by the user' }
    case 'rejected':
      return { approved: false, reason: 'rejected by the user' }
    case 'cancelled':
      return { approved: false, reason: 'the approval request was withdrawn' }
    case 'unavailable':
      return { approved: false, reason: 'no approval channel is available, so the request fails closed' }
  }
}
