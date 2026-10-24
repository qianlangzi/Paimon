/**
 * The completion policies the model may choose when creating a task.
 *
 * A task with no rule can never be verified, so `paimon_task_create` always
 * installs one. The modes are deliberately few and coarse: a richer policy
 * language would let the model describe its own success condition, which is
 * exactly the authority PRD 4.3/CODE-006 withholds from it.
 *
 * The rules are produced as *specs* rather than closures. A closure cannot be
 * persisted, and a task reloaded from disk without its rules can never be
 * verified — so the serialisable form is the source of truth here and the
 * runtime rebuilds the executable rule when it needs one.
 */

import {
  type ValidationRule,
  type ValidationRuleSpec,
  ruleFromSpec,
} from '@deepseek-ai/dsh-paimon-task-runtime'

/** Completion policies selectable at task creation. */
export type CompletionMode = 'auto' | 'tests' | 'tool-success'

/** Every mode, for the parameter enum and runtime validation. */
export const COMPLETION_MODES: readonly CompletionMode[] = ['auto', 'tests', 'tool-success']

/**
 * Default mode: whichever policy the deployment can actually verify.
 *
 * `tests` was the original default and was unusable out of the box: the shipped
 * profile declares no test tool, so no `test-report` evidence can ever exist and
 * every task made by the model was permanently unfinishable. `auto` picks
 * `tests` when a test runner is declared and falls back to `tool-success`
 * otherwise, instead of promising a verification the deployment cannot perform.
 */
export const DEFAULT_COMPLETION_MODE: CompletionMode = 'auto'

/** What the caller knows about the deployment when choosing a policy. */
export interface CompletionContext {
  /** Whether any tool is declared to mean "the tests passed". */
  readonly hasTestTools: boolean
}

/** Builds the rules for one mode, in serialisable form. */
export function completionRuleSpecs(
  mode: CompletionMode,
  context: CompletionContext,
): readonly ValidationRuleSpec[] {
  const tests: ValidationRuleSpec = {
    kind: 'test-report',
    id: 'tests',
    description: 'the declared test tool reported success',
  }
  const toolSuccess: ValidationRuleSpec = {
    kind: 'any-tool-success',
    id: 'tool-success',
    description: 'at least one tool call succeeded',
  }
  switch (mode) {
    case 'tests': return [tests]
    case 'tool-success': return [toolSuccess]
    case 'auto': return context.hasTestTools ? [tests] : [toolSuccess]
  }
}

/** The same rules as executable closures, for callers that validate in-process. */
export function completionRules(
  mode: CompletionMode,
  context: CompletionContext,
): readonly ValidationRule[] {
  return completionRuleSpecs(mode, context).map(ruleFromSpec)
}
