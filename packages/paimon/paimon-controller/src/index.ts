/**
 * Host-side read model for the Paimon desktop surfaces.
 *
 * Step S1 of `Paimon-M5-Plan.md`. It answers the two questions every view asks
 * — "what tasks are there" and "what happened in this one" — in the shapes the
 * views render, and nothing else. Write operations (cancel, abandon) stay out
 * of this package on purpose: they belong to a later step, and a read-only
 * controller cannot accidentally become a second place that decides state.
 *
 * The remote contract (`ctx.remote.paimonTask`) is generated from this service
 * in S2; until then the service is reachable from the Host and from tests.
 *
 * @module @deepseek-ai/dsh-paimon-controller
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-paimon-task-harness'
import { type TaskDetailDto, type TaskRowDto, toTaskDetail, toTaskRow } from './types.ts'

export type {
  CheckDto,
  RunDto,
  TaskDetailDto,
  TaskEventDto,
  TaskRowDto,
} from './types.ts'

/** Default timeline window, matching what a detail panel can scroll comfortably. */
const DEFAULT_EVENT_LIMIT = 200

/**
 * Read model over the task governance layer, exposed as `ctx.paimonTask`.
 *
 * Requires `paimonTasks`: without the adapter there is nothing to read, and a
 * composition that omits it should not activate this service rather than serve
 * empty lists that look like "no tasks".
 */
export class PaimonTaskController extends Service {
  static inject = ['paimonTasks']

  constructor(ctx: Context) {
    super(ctx, 'paimonTask')
  }

  /**
   * Every recorded task, newest activity first.
   *
   * The list is the entry point for all four views, so it is sorted here rather
   * than in each view: a persisted history has no natural order, and two views
   * disagreeing about "most recent" would be a bug nobody owns.
   */
  list(): readonly TaskRowDto[] {
    return this.ctx.paimonTasks.listTasks()
      .map(toTaskRow)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * One task with its attempts and timeline.
   *
   * @param eventLimit - Keep only the most recent N events. Defaults to
   * {@link DEFAULT_EVENT_LIMIT}; a long task can hold thousands.
   */
  detail(taskId: string, eventLimit: number = DEFAULT_EVENT_LIMIT): TaskDetailDto {
    return toTaskDetail(this.ctx.paimonTasks.taskDetail(taskId, eventLimit))
  }
}

export default PaimonTaskController
