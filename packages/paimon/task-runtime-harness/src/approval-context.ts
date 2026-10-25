/**
 * The context one approval prompt carries for a Paimon task.
 *
 * The harness already tells an answerer *which tool* wants to run. What it
 * cannot know is *whose goal* that call belongs to, and without that a browser
 * approval card is undecidable the moment more than one task is live: "read_file
 * needs a decision" names no task, no attempt and no reason. The same gap makes
 * the audit log useless afterwards — `approval/asked` records a tool name and a
 * generic sentence, so a refusal six hours later cannot be traced to the goal it
 * belonged to.
 *
 * So the adapter adds the task's goal and attempt number to the one payload the
 * harness forwards to its answerers, and changes nothing about the decision
 * semantics. Both fields the harness offers are filled, because they have
 * different readers:
 *
 * - `reason` is the durable audit string: English, stable, never localized, and
 *   the only form that lands in the session log.
 * - `displayReason` is presentation copy the client resolves in the user's own
 *   locale (`ApprovalPresentationRequest` in `dsh-client-ui-approval`).
 *
 * Pure functions on purpose: the copy rules (flattening, truncation, attempt
 * clamping) are the part worth testing without a tool pipeline.
 *
 * @module @deepseek-ai/dsh-paimon-task-harness/approval-context
 */

/** The two strings one approval prompt needs, in the shape the harness takes. */
export interface ApprovalContext {
  /** Durable audit sentence; English, never localized. */
  readonly reason: string
  /** Presentation copy, resolved by the client in the user's locale. */
  readonly displayReason: { readonly en: string; readonly [locale: string]: string }
}

/** What a prompt needs from a task: the goal it serves and which attempt is asking. */
export interface ApprovalTaskRef {
  readonly goal: string
  /** 1-based attempt counter — the run this call belongs to. */
  readonly attempt: number
}

/**
 * Longest goal excerpt a prompt carries.
 *
 * A goal is user prose and can be a paragraph. Past this width the card turns
 * into a wall of text and the reader loses the question at the end of it, so the
 * excerpt stops here and the full text stays in the task record.
 */
export const GOAL_EXCERPT_LIMIT = 100

/**
 * One line of goal text, short enough to read inside a prompt.
 *
 * Newlines are collapsed rather than preserved: the goal is rendered into a
 * single sentence, and a line break inside it would look like the end of the
 * question. An empty goal still produces a label, because a prompt that reads
 * `Task "": allow read_file to run?` is worse than one that admits it has
 * nothing to name.
 * @param goal - the task goal as the user or the model wrote it.
 * @returns the goal on one line, truncated to {@link GOAL_EXCERPT_LIMIT}.
 */
export function summarizeGoal(goal: string): string {
  const flat = goal.replace(/\s+/gu, ' ').trim()
  if (flat.length === 0) return '(no goal)'
  if (flat.length <= GOAL_EXCERPT_LIMIT) return flat
  return `${flat.slice(0, GOAL_EXCERPT_LIMIT - 1)}…`
}

/**
 * Build the prompt text for one gated call.
 *
 * @param task - the task the call belongs to, or `undefined` when the caller
 *   could not resolve one. The fallback matters: a prompt that names only the
 *   tool is still better than refusing to ask, because a call must never run
 *   without a decision just because its context was missing.
 * @param toolName - the tool the decision is about.
 * @returns the audit reason and the localized presentation copy.
 */
export function approvalContextOf(task: ApprovalTaskRef | undefined, toolName: string): ApprovalContext {
  if (task === undefined) {
    return {
      reason: `the call to ${toolName} needs a human decision`,
      displayReason: {
        en: `Allow ${toolName} to run?`,
        zh: `是否允许运行 ${toolName}？`,
      },
    }
  }
  const goal = summarizeGoal(task.goal)
  // Clamped: an attempt counter of 0 can only come from a task that never
  // started a run, and "attempt 0" reads as a bug to the person deciding.
  const attempt = Math.max(1, Math.trunc(task.attempt))
  return {
    reason: `task "${goal}" (attempt ${attempt}) needs a decision before running ${toolName}`,
    displayReason: {
      en: `Task "${goal}", attempt ${attempt}: allow ${toolName} to run?`,
      zh: `任务「${goal}」第 ${attempt} 次尝试：是否允许运行 ${toolName}？`,
    },
  }
}
