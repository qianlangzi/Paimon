/**
 * Copy for the task strip.
 *
 * Keys live here rather than inline so the dictionary stays the single place a
 * translator edits; the `goal` strip next door follows the same shape.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'paimonTasks'

/** English copy. */
export const en = {
  'strip.count': '{count} task(s)',
  'strip.running': '{count} running',
  'strip.waiting': '{count} awaiting approval',
  'strip.newest': 'latest: {goal}',
  'strip.refresh': 'Refresh tasks',
  'strip.error': 'tasks unavailable: {message}',
} as const

/** Chinese copy. */
export const zh = {
  'strip.count': '{count} 个任务',
  'strip.running': '{count} 个运行中',
  'strip.waiting': '{count} 个待审批',
  'strip.newest': '最新：{goal}',
  'strip.refresh': '刷新任务',
  'strip.error': '任务读取失败：{message}',
} as const

/**
 * Every key this plugin renders.
 *
 * A union of the dictionary's own keys, not an interface: the slot layer
 * derives the translate function's key domain from this type, so widening it to
 * `string` would silently accept a typo in a component.
 */
export type PaimonTasksKey = keyof typeof zh
