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
  'strip.refresh': 'Refresh tasks',
  'strip.error': 'tasks unavailable: {message}',
  'strip.stale': 'last read failed',
  'strip.more': '+{count} more',
  'detail.attempt': 'attempt {attempt}',
  'detail.workspace': 'workspace: {workspace}',
  'detail.loading': 'reading the task…',
  'detail.error': 'could not read this task: {message}',
  'detail.runs': 'attempts',
  'detail.checks': 'completion checks',
  'detail.timeline': 'timeline',
  'detail.verified': 'verified by observed evidence',
  'detail.unverified': 'not verified',
  'detail.empty': 'nothing recorded yet',
  'detail.close': 'Close',
  'detail.tab.record': 'record',
  'detail.tab.diagnostics': 'diagnostics',
  'diag.budget': 'attempt budget {used}/{max}',
  'diag.budgetLeft': '{count} attempt(s) left',
  'diag.budgetSpent': 'no attempts left',
  'diag.retryable': 'retryable: {kinds}',
  'diag.deadline': 'deadline {at}',
  'diag.deadlineExceeded': 'wall-clock budget spent',
  'diag.noDeadline': 'no wall-clock budget',
  'diag.workspace': 'boundary {workspace}',
  'diag.noWorkspace': 'no workspace boundary declared',
  'diag.cancelRequested': 'stop requested {at}',
  'diag.cancelAcknowledged': 'stop confirmed {at}',
  'diag.attempts': 'attempt history',
  'diag.noAttempts': 'no attempt has started',
  'diag.retried': 'retried',
  'diag.stopped': 'not retried',
  'diag.running': 'still running',
  'diag.duration': '{seconds}s',
} as const

/** Chinese copy. */
export const zh = {
  'strip.count': '{count} 个任务',
  'strip.running': '{count} 个运行中',
  'strip.waiting': '{count} 个待审批',
  'strip.refresh': '刷新任务',
  'strip.error': '任务读取失败：{message}',
  'strip.stale': '本次刷新失败',
  'strip.more': '还有 {count} 个',
  'detail.attempt': '第 {attempt} 次尝试',
  'detail.workspace': '工作目录：{workspace}',
  'detail.loading': '正在读取任务…',
  'detail.error': '任务详情读取失败：{message}',
  'detail.runs': '尝试记录',
  'detail.checks': '完成条件',
  'detail.timeline': '时间线',
  'detail.verified': '已由观测到的证据确认',
  'detail.unverified': '尚未确认',
  'detail.empty': '暂无记录',
  'detail.close': '关闭',
  'detail.tab.record': '记录',
  'detail.tab.diagnostics': '诊断',
  'diag.budget': '尝试预算 {used}/{max}',
  'diag.budgetLeft': '还剩 {count} 次',
  'diag.budgetSpent': '尝试预算已用尽',
  'diag.retryable': '可重试：{kinds}',
  'diag.deadline': '截止时间 {at}',
  'diag.deadlineExceeded': '时间预算已耗尽',
  'diag.noDeadline': '未设时间预算',
  'diag.workspace': '边界目录 {workspace}',
  'diag.noWorkspace': '未声明工作目录边界',
  'diag.cancelRequested': '取消请求于 {at}',
  'diag.cancelAcknowledged': '停止确认于 {at}',
  'diag.attempts': '尝试历史',
  'diag.noAttempts': '尚未开始尝试',
  'diag.retried': '已重试',
  'diag.stopped': '未重试',
  'diag.running': '进行中',
  'diag.duration': '{seconds} 秒',
} as const

/**
 * Every key this plugin renders.
 *
 * A union of the dictionary's own keys, not an interface: the slot layer
 * derives the translate function's key domain from this type, so widening it to
 * `string` would silently accept a typo in a component.
 */
export type PaimonTasksKey = keyof typeof zh
