import type { Evidence } from '@deepseek-ai/dsh-paimon-task-runtime'

/**
 * Structural view of a tool result.
 *
 * Declared locally instead of importing the harness `ToolExecutionResult` so
 * the extraction rules stay testable with plain objects and cannot quietly
 * start depending on harness internals.
 */
export interface ToolResultLike {
  readonly isError?: boolean | undefined
  readonly error?: { readonly message?: string | undefined } | undefined
}

/** One observed tool outcome, ready to become evidence. */
export interface EvidenceInput {
  /** Harness call id; makes the evidence ids stable and unique per call. */
  readonly callId: string
  readonly toolName: string
  readonly result: ToolResultLike
  /**
   * Tool names whose success means "the tests passed".
   *
   * This is a declaration, not a guess. The adapter cannot read a test report
   * out of arbitrary stdout without inventing a parser per framework, so the
   * operator names the test tools and the adapter records their success as a
   * `test-report`. An undeclared tool produces only `tool-result` evidence,
   * which no test rule will accept.
   */
  readonly testTools?: readonly string[] | undefined
}

/**
 * Turns one tool outcome into evidence.
 *
 * Always emits a `tool-result`, which is authoritative for "did the call
 * succeed" and nothing more. Emits a `test-report` only for a declared test
 * tool. Never emits a `model-claim`, because a claim is not an observation.
 */
export function extractEvidence(input: EvidenceInput): Evidence[] {
  const failed = input.result.isError === true
  const detail = describe(input.result)
  const evidence: Evidence[] = [
    {
      id: `${input.callId}:tool`,
      kind: 'tool-result',
      ref: `tool:${input.toolName}`,
      passed: !failed,
      detail,
    },
  ]
  if (input.testTools?.includes(input.toolName) === true) {
    evidence.push({
      id: `${input.callId}:tests`,
      kind: 'test-report',
      ref: `tool:${input.toolName}`,
      passed: !failed,
      detail,
    })
  }
  return evidence
}

function describe(result: ToolResultLike): string {
  const message = result.error?.message
  if (typeof message === 'string' && message.length > 0) return message
  return result.isError === true ? 'the tool reported an error' : 'the tool completed'
}
