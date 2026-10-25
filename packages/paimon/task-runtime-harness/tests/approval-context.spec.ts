import { describe, expect, it } from 'vitest'
import { GOAL_EXCERPT_LIMIT, approvalContextOf, summarizeGoal } from '../src/approval-context.ts'

/**
 * The prompt's copy rules, without a tool pipeline.
 *
 * The decision path is covered by the pipeline spec; what is worth pinning here
 * is the text a human reads while a call is blocked. Getting it wrong does not
 * fail loudly — it produces a card that is merely unhelpful, which is the kind
 * of defect a test suite is the only defence against.
 */

describe('summarizeGoal', () => {
  it('keeps a short goal as written', () => {
    expect(summarizeGoal('rename the loader')).toBe('rename the loader')
  })

  it('collapses newlines so the question stays one sentence', () => {
    expect(summarizeGoal('fix the bug\nin the loader\tplease')).toBe('fix the bug in the loader please')
  })

  it('truncates a long goal to the excerpt limit, ellipsis included', () => {
    const goal = 'a'.repeat(GOAL_EXCERPT_LIMIT + 40)
    const summary = summarizeGoal(goal)
    expect(summary).toHaveLength(GOAL_EXCERPT_LIMIT)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('labels an empty goal instead of quoting nothing', () => {
    expect(summarizeGoal('   \n ')).toBe('(no goal)')
  })
})

describe('approvalContextOf', () => {
  it('names the goal, the attempt and the tool in both locales', () => {
    const context = approvalContextOf({ goal: 'rename the loader', attempt: 2 }, 'read_file')
    expect(context.reason).toBe('task "rename the loader" (attempt 2) needs a decision before running read_file')
    expect(context.displayReason.en).toBe('Task "rename the loader", attempt 2: allow read_file to run?')
    expect(context.displayReason.zh).toBe('任务「rename the loader」第 2 次尝试：是否允许运行 read_file？')
  })

  it('keeps the audit reason in English and the presentation copy localized', () => {
    const context = approvalContextOf({ goal: '修复加载器', attempt: 1 }, 'write_file')
    expect(context.reason).toContain('修复加载器')
    expect(context.displayReason.zh).toContain('修复加载器')
    expect(context.displayReason.en).not.toContain('任务')
  })

  it('clamps a never-started attempt to 1 so the copy never reads "attempt 0"', () => {
    expect(approvalContextOf({ goal: 'g', attempt: 0 }, 'read_file').reason).toContain('attempt 1')
    expect(approvalContextOf({ goal: 'g', attempt: -3 }, 'read_file').reason).toContain('attempt 1')
  })

  it('falls back to tool-only copy rather than refusing to ask', () => {
    const context = approvalContextOf(undefined, 'run_shell')
    expect(context.reason).toBe('the call to run_shell needs a human decision')
    expect(context.displayReason.zh).toBe('是否允许运行 run_shell？')
  })

  it('excerpts the goal before it reaches the prompt', () => {
    const context = approvalContextOf({ goal: 'b'.repeat(GOAL_EXCERPT_LIMIT + 20), attempt: 1 }, 'read_file')
    expect(context.reason).not.toContain('b'.repeat(GOAL_EXCERPT_LIMIT + 1))
    expect(context.reason).toContain('…')
  })
})
