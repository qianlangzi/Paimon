import type {
  CheckOutcome,
  Evidence,
  EvidenceKind,
  ValidationCheck,
  ValidationReport,
} from './types.ts'

/**
 * Evidence kinds the validator is willing to act on.
 *
 * `model-claim` is absent on purpose. The model saying "the tests pass" is not
 * evidence that the tests passed; it is a claim about evidence that should
 * already exist. PRD 4.3/CODE-006 and acceptance scenario 10 both require that
 * a task cannot be reported as verified on the model's word alone, so the
 * validator filters claims out before any rule runs.
 */
export const AUTHORITATIVE_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'tool-result',
  'command-exit',
  'test-report',
  'file-state',
]

/** Whether a rule may treat this evidence kind as proof. */
export function isAuthoritative(kind: EvidenceKind): boolean {
  return AUTHORITATIVE_EVIDENCE_KINDS.includes(kind)
}

/** Drops non-authoritative evidence, keeping the original order. */
export function authoritativeOnly(evidence: readonly Evidence[]): readonly Evidence[] {
  return evidence.filter(item => isAuthoritative(item.kind))
}

/**
 * One completion condition.
 *
 * A rule receives only authoritative evidence when produced by the factories
 * below. A custom rule is responsible for calling {@link authoritativeOnly}
 * itself, which is why {@link customRule} does it on the caller's behalf.
 */
export interface ValidationRule {
  readonly id: string
  readonly description: string
  evaluate(evidence: readonly Evidence[]): ValidationCheck
}

/** Options shared by the built-in rule factories. */
interface BaseRuleOptions {
  readonly id: string
  readonly description: string
}

/** Requires a command to have exited with an expected code. */
export function commandExitRule(
  options: BaseRuleOptions & { readonly commandRef: string; readonly expectExitCode?: number },
): ValidationRule {
  const expected = options.expectExitCode ?? 0
  return {
    id: options.id,
    description: options.description,
    evaluate: (evidence) => {
      const match = authoritativeOnly(evidence).filter(
        item => item.kind === 'command-exit' && item.ref === options.commandRef,
      )
      return toCheck(options, match, `expected exit code ${expected}`, item => item.passed === true)
    },
  }
}

/**
 * Requires a test report to show success.
 *
 * With `ref` the rule targets one report; without it every test report must
 * pass, so a single failing suite fails the check even if another passed.
 */
export function testReportRule(
  options: BaseRuleOptions & { readonly ref?: string },
): ValidationRule {
  return {
    id: options.id,
    description: options.description,
    evaluate: (evidence) => {
      const match = authoritativeOnly(evidence).filter(
        item => item.kind === 'test-report' && (options.ref === undefined || item.ref === options.ref),
      )
      if (match.length === 0) {
        return {
          id: options.id,
          description: options.description,
          outcome: 'not-checked',
          evidence: [],
          note: 'no test report was collected',
        }
      }
      const failed = match.filter(item => item.passed === false)
      const outcome: CheckOutcome = failed.length > 0 ? 'failed' : 'passed'
      return {
        id: options.id,
        description: options.description,
        outcome,
        evidence: match.map(item => item.id),
        note: failed.length > 0
          ? `${failed.length} of ${match.length} test report(s) failed`
          : `${match.length} test report(s) passed`,
      }
    },
  }
}

/** Requires a file to be in an expected state (present, or absent). */
export function fileStateRule(
  options: BaseRuleOptions & { readonly path: string; readonly expectPresent?: boolean },
): ValidationRule {
  const expectPresent = options.expectPresent ?? true
  return {
    id: options.id,
    description: options.description,
    evaluate: (evidence) => {
      const match = authoritativeOnly(evidence).filter(
        item => item.kind === 'file-state' && item.ref === options.path,
      )
      if (match.length === 0) {
        return {
          id: options.id,
          description: options.description,
          outcome: 'not-checked',
          evidence: [],
          note: `no file state was observed for ${options.path}`,
        }
      }
      const satisfied = match.some(item => item.passed === expectPresent)
      return {
        id: options.id,
        description: options.description,
        outcome: satisfied ? 'passed' : 'failed',
        evidence: match.map(item => item.id),
        note: satisfied ? undefined : `expected ${options.path} to be ${expectPresent ? 'present' : 'absent'}`,
      }
    },
  }
}

/**
 * Wraps a caller-supplied predicate.
 *
 * The predicate only ever sees authoritative evidence, so a custom rule cannot
 * accidentally accept a model claim.
 */
export function customRule(
  options: BaseRuleOptions & { readonly evaluate: (evidence: readonly Evidence[]) => CheckOutcome },
): ValidationRule {
  return {
    id: options.id,
    description: options.description,
    evaluate: (evidence) => {
      const trusted = authoritativeOnly(evidence)
      const outcome = options.evaluate(trusted)
      return {
        id: options.id,
        description: options.description,
        outcome,
        evidence: trusted.map(item => item.id),
        note: undefined,
      }
    },
  }
}

function toCheck(
  options: BaseRuleOptions,
  match: readonly Evidence[],
  expectation: string,
  predicate: (item: Evidence) => boolean,
): ValidationCheck {
  if (match.length === 0) {
    return {
      id: options.id,
      description: options.description,
      outcome: 'not-checked',
      evidence: [],
      note: `no matching evidence (${expectation})`,
    }
  }
  const satisfied = match.some(predicate)
  return {
    id: options.id,
    description: options.description,
    outcome: satisfied ? 'passed' : 'failed',
    evidence: match.map(item => item.id),
    note: satisfied ? undefined : `no matching evidence satisfied ${expectation}`,
  }
}

/**
 * Evaluates a fixed set of completion rules against collected evidence.
 *
 * The central guarantee: `satisfied` is true only when at least one rule
 * exists and *every* rule passed. A rule that could not be checked counts as a
 * failure to verify, not as a pass, because "we did not look" is not evidence
 * of completion.
 */
export class ResultValidator {
  constructor(private readonly rules: readonly ValidationRule[]) {}

  /** Rules this validator enforces, in declaration order. */
  get configuredRules(): readonly ValidationRule[] {
    return this.rules
  }

  /** Evaluates every rule and returns a report suitable for `TaskResult`. */
  validate(evidence: readonly Evidence[]): ValidationReport {
    const checks = this.rules.map(rule => rule.evaluate(evidence))
    return {
      satisfied: checks.length > 0 && checks.every(check => check.outcome === 'passed'),
      checks,
    }
  }
}
