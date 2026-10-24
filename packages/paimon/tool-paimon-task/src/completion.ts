/**
 * The completion policies the model may choose when creating a task.
 *
 * A task with no rule can never be verified, so `paimon_task_create` always
 * installs one. The modes are deliberately few and coarse: a richer policy
 * language would let the model describe its own success condition, which is
 * exactly the authority PRD 4.3/CODE-006 withholds from it.
 */

import { customRule, testReportRule, type ValidationRule } from '@deepseek-ai/dsh-paimon-task-runtime'

/** Completion policies selectable at task creation. */
export type CompletionMode = 'tests' | 'tool-success'

/** Every mode, for the parameter enum and runtime validation. */
export const COMPLETION_MODES: readonly CompletionMode[] = ['tests', 'tool-success']

/** Default mode: the strictest one that still works out of the box. */
export const DEFAULT_COMPLETION_MODE: CompletionMode = 'tests'

/**
 * Builds the rules for one mode.
 *
 * `tests` requires a passing test report, which only exists when the deployment
 * declares its test tools — an undeclared runner leaves the task unverifiable,
 * which is the honest outcome rather than a rubber stamp.
 *
 * `tool-success` is the weaker fallback for tasks whose correctness is not
 * machine-checkable: it only asks that something actually ran and succeeded.
 * It is offered, not defaulted, because it proves very little.
 */
export function completionRules(mode: CompletionMode): readonly ValidationRule[] {
  switch (mode) {
    case 'tests':
      return [testReportRule({
        id: 'tests',
        description: 'the declared test tool reported success',
      })]
    case 'tool-success':
      return [customRule({
        id: 'tool-success',
        description: 'at least one tool call succeeded',
        evaluate: evidence => evidence.some(
          item => item.kind === 'tool-result' && item.passed === true,
        ) ? 'passed' : 'not-checked',
      })]
  }
}
