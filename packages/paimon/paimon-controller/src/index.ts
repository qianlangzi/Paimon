/**
 * Host-side read model for the Paimon desktop surfaces.
 *
 * Step S1 of `Paimon-M5-Plan.md`, and the Host half of S2: it answers the two
 * questions every view asks — "what tasks are there" and "what happened in this
 * one" — in the shapes the views render, and exposes them as the `paimonTask`
 * Remote namespace.
 *
 * Write operations (cancel, abandon) stay out of this package on purpose: they
 * belong to a later step, and a read-only controller cannot accidentally become
 * a second place that decides state.
 *
 * @module @deepseek-ai/dsh-paimon-controller
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-paimon-task-harness'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TaskDetailDto, TaskRowDto } from './types.ts'
import { toTaskDetail, toTaskRow } from './project.ts'

export type {
  CheckDto,
  RunDto,
  TaskDetailDto,
  TaskEventDto,
  TaskEventValue,
  TaskOutcomeDto,
  TaskRowDto,
  TaskStatusDto,
} from './types.ts'
export { toTaskDetail, toTaskRow } from './project.ts'

/** Default timeline window, matching what a detail panel can scroll comfortably. */
const DEFAULT_EVENT_LIMIT = 200

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read model the Paimon desktop surfaces ask. */
    paimonTask: PaimonTaskController
  }
}

/**
 * Read model over the task governance layer, exposed as `ctx.paimonTask` and as
 * the `paimonTask` Remote namespace.
 *
 * Requires `paimonTasks`: without the adapter there is nothing to read, and a
 * composition that omits it should not activate this service rather than serve
 * empty lists that look like "no tasks".
 */
export class PaimonTaskController extends TypertRemoteService {
  static inject = ['paimonTasks']

  constructor(ctx: Context) {
    super(ctx, 'paimonTask', { namespace: 'paimonTask' })
  }

  /**
   * Every recorded task, newest activity first.
   *
   * The list is the entry point for all four views, so it is sorted here rather
   * than in each view: a persisted history has no natural order, and two views
   * disagreeing about "most recent" would be a bug nobody owns.
   *
   * @returns one row per task.
   */
  @Remote
  async list(): Promise<readonly TaskRowDto[]> {
    return this.ctx.paimonTasks.listTasks()
      .map(toTaskRow)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * One task with its attempts and timeline.
   *
   * @param taskId - task to read; an unknown id rejects rather than returning an
   * empty detail, because "no such task" and "a task with nothing in it" are
   * different facts and a view shows them differently.
   * @param eventLimit - keep only the most recent N events; omitted means
   * {@link DEFAULT_EVENT_LIMIT}.
   * @returns the detail payload.
   */
  @Remote
  async detail(taskId: string, eventLimit?: number): Promise<TaskDetailDto> {
    // `async` rather than `Promise.resolve(...)`: a synchronous throw from the
    // adapter would otherwise escape as a throw instead of a rejection, which a
    // Remote caller has no way to observe and the dispatcher would surface as a
    // transport failure.
    // The default cannot live on the Remote signature — the generator rejects
    // defaulted parameters, because the wire contract has no way to express
    // one — so it is applied here instead.
    //
    // The window is applied *after* the projection, not before: a non-final
    // validation report only exists as an event, so truncating the timeline
    // first would make the checks disappear on any task whose last probe fell
    // outside the window — which is every task that retried a few times. The
    // adapter already holds the whole log in memory, so this costs a projection
    // of the discarded rows and nothing else.
    const detail = toTaskDetail(this.ctx.paimonTasks.taskDetail(taskId))
    const keep = Math.max(0, Math.trunc(eventLimit ?? DEFAULT_EVENT_LIMIT))
    return keep >= detail.events.length ? detail : { ...detail, events: keep === 0 ? [] : detail.events.slice(-keep) }
  }
}

export default PaimonTaskController
