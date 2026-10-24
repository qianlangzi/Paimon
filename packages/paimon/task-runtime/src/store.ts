import type { EventFilter, Run, Task, TaskEvent } from './types.ts'

/**
 * Persistence port for the task governance layer.
 *
 * Kept intentionally small: the runtime reads and writes whole aggregates. A
 * SQLite or JSONL adapter implements this interface later without the runtime
 * knowing which one is in use.
 *
 * `Task` and `Run` objects are stored as-is; callers must treat them as
 * copy-on-write and hand a fresh object to `saveTask` rather than mutating one
 * they already stored. The in-memory adapter relies on that discipline, and a
 * durable adapter gets the same guarantee for free by serialising on save.
 */
export interface TaskStore {
  saveTask(task: Task): void
  getTask(taskId: string): Task | undefined
  listTasks(): readonly Task[]

  saveRun(run: Run): void
  getRun(runId: string): Run | undefined
  listRuns(taskId: string): readonly Run[]

  appendEvent(event: TaskEvent): void
  listEvents(filter?: EventFilter): readonly TaskEvent[]
}

/**
 * Process-local store used by tests and by the first prototype.
 *
 * Deliberately not durable. PRD 9.1 allows an in-memory implementation for the
 * state-machine and event prototype; durability arrives with the storage
 * adapter milestone, at which point this class stays as the test double.
 */
export class MemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, Task>()
  readonly #runs = new Map<string, Run>()
  readonly #events: TaskEvent[] = []

  saveTask(task: Task): void {
    this.#tasks.set(task.id, task)
  }

  getTask(taskId: string): Task | undefined {
    return this.#tasks.get(taskId)
  }

  listTasks(): readonly Task[] {
    return [...this.#tasks.values()]
  }

  saveRun(run: Run): void {
    this.#runs.set(run.id, run)
  }

  getRun(runId: string): Run | undefined {
    return this.#runs.get(runId)
  }

  listRuns(taskId: string): readonly Run[] {
    return [...this.#runs.values()]
      .filter(run => run.taskId === taskId)
      .sort((left, right) => left.attempt - right.attempt)
  }

  appendEvent(event: TaskEvent): void {
    this.#events.push(event)
  }

  listEvents(filter: EventFilter = {}): readonly TaskEvent[] {
    return this.#events.filter((event) => {
      if (filter.taskId !== undefined && event.taskId !== filter.taskId) return false
      if (filter.runId !== undefined && event.runId !== filter.runId) return false
      if (filter.type !== undefined && event.type !== filter.type) return false
      return true
    })
  }
}
