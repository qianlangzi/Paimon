/**
 * Durable, file-backed implementation of the Paimon `TaskStore` port.
 *
 * Three files under one directory:
 *
 * - `tasks.json`  — every task, keyed by id
 * - `runs.json`   — every run, keyed by id
 * - `events.jsonl` — one event per line, appended
 *
 * The split is deliberate. Task and run state is small, is rewritten whole, and
 * has to be internally consistent, so it gets an atomic replace. Events are
 * append-only facts that only ever grow, so they get an append with no rewrite
 * cost and no chance of losing history to a failed rewrite.
 *
 * @module @deepseek-ai/dsh-paimon-task-store-file
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EventFilter,
  Run,
  Task,
  TaskEvent,
  TaskStore,
} from '@deepseek-ai/dsh-paimon-task-runtime'

/** Where the store keeps its files. */
export interface FileTaskStoreOptions {
  /** Directory holding the three files. Created when missing. */
  readonly directory: string
}

/** Name of the task snapshot file. */
export const TASKS_FILE = 'tasks.json'
/** Name of the run snapshot file. */
export const RUNS_FILE = 'runs.json'
/** Name of the append-only event log. */
export const EVENTS_FILE = 'events.jsonl'
/** On-disk layout version, so a future change can refuse rather than guess. */
export const FORMAT_VERSION = 1

interface Snapshot<T> {
  readonly version: number
  readonly items: Record<string, T>
}

/**
 * A `TaskStore` that survives a restart.
 *
 * Every mutation is written through before it returns, so a process that dies
 * immediately after a call still has that call's effect on disk. That costs a
 * synchronous write per mutation, which is the right trade for a single-user
 * local tool and the wrong one for a server; a batched or transactional
 * adapter can implement the same port without the runtime noticing.
 */
export class FileTaskStore implements TaskStore {
  private readonly directory: string
  private readonly tasks = new Map<string, Task>()
  private readonly runs = new Map<string, Run>()
  private readonly events: TaskEvent[] = []
  private readonly problemList: string[] = []

  constructor(options: FileTaskStoreOptions) {
    this.directory = options.directory
    mkdirSync(this.directory, { recursive: true })
    this.load()
  }

  /** Absolute directory this store owns. */
  get location(): string {
    return this.directory
  }

  /**
   * Files that could not be read and were quarantined instead.
   *
   * Exposed rather than logged so the caller decides how loud to be: a boot
   * that silently discarded history would be worse than a noisy one, and this
   * module has no logger to be noisy with.
   */
  get problems(): readonly string[] {
    return this.problemList
  }

  saveTask(task: Task): void {
    this.tasks.set(task.id, task)
    this.writeSnapshot(TASKS_FILE, this.tasks)
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  listTasks(): readonly Task[] {
    return [...this.tasks.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  saveRun(run: Run): void {
    this.runs.set(run.id, run)
    this.writeSnapshot(RUNS_FILE, this.runs)
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId)
  }

  listRuns(taskId: string): readonly Run[] {
    return [...this.runs.values()]
      .filter(run => run.taskId === taskId)
      .sort((left, right) => left.attempt - right.attempt)
  }

  appendEvent(event: TaskEvent): void {
    this.events.push(event)
    appendFileSync(join(this.directory, EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8')
  }

  listEvents(filter: EventFilter = {}): readonly TaskEvent[] {
    return this.events.filter((event) => {
      if (filter.taskId !== undefined && event.taskId !== filter.taskId) return false
      if (filter.runId !== undefined && event.runId !== filter.runId) return false
      if (filter.type !== undefined && event.type !== filter.type) return false
      return true
    })
  }

  /**
   * Replaces a snapshot atomically.
   *
   * Written to a sibling temp file and renamed over the target, so a crash
   * mid-write leaves the previous snapshot intact instead of a half-written
   * document that would make the whole history unreadable. The temp name
   * carries the pid so two processes sharing a home cannot write into the same
   * scratch file and hand each other a torn result.
   */
  private writeSnapshot(name: string, items: Map<string, Task | Run>): void {
    const target = join(this.directory, name)
    const temporary = `${target}.${process.pid}.tmp`
    const snapshot: Snapshot<Task | Run> = {
      version: FORMAT_VERSION,
      items: Object.fromEntries(items),
    }
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  }

  /**
   * Loads the three files, quarantining any that cannot be read.
   *
   * Unreadable history must not be fatal: task records describe past work,
   * while the harness is the product, and a store that refuses to construct
   * takes the whole agent down with it. The damaged file is renamed with a
   * `.corrupt` suffix and left in place, so the data is still there to inspect
   * and the reason is reported through {@link problems}.
   */
  private load(): void {
    this.attempt(TASKS_FILE, () => this.loadTasks(), () => this.tasks.clear())
    this.attempt(RUNS_FILE, () => this.loadRuns(), () => this.runs.clear())
    this.attempt(EVENTS_FILE, () => this.loadEvents(), () => { this.events.length = 0 })
  }

  private attempt(name: string, load: () => void, reset: () => void): void {
    try {
      load()
    } catch (error) {
      reset()
      const path = join(this.directory, name)
      const quarantined = `${path}.corrupt`
      let detail = ''
      try {
        renameSync(path, quarantined)
        detail = ` (moved to ${quarantined})`
      } catch {
        // A file that cannot be moved is still skipped rather than fatal.
      }
      this.problemList.push(`${name} could not be read${detail}: ${messageOf(error)}`)
    }
  }

  private loadTasks(): void {
    for (const task of this.readSnapshot<Task>(TASKS_FILE)) this.tasks.set(task.id, task)
  }

  private loadRuns(): void {
    for (const run of this.readSnapshot<Run>(RUNS_FILE)) this.runs.set(run.id, run)
  }

  private readSnapshot<T extends { id: string }>(name: string): T[] {
    const path = join(this.directory, name)
    if (!existsSync(path)) return []
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${path} is not a snapshot document`)
    }
    const snapshot = parsed as Partial<Snapshot<T>>
    if (snapshot.version !== FORMAT_VERSION) {
      throw new Error(`${path} declares version ${String(snapshot.version)}; this build reads ${FORMAT_VERSION}`)
    }
    return Object.values(snapshot.items ?? {})
  }

  /**
   * Reads the event log, tolerating exactly one kind of damage.
   *
   * A process killed mid-append leaves a partial final line. That line is
   * discarded, because the alternative — refusing to start — would turn a
   * crash into permanent data loss. Any *other* unparseable line means the file
   * was corrupted by something other than a torn write, and that is reported
   * instead of silently skipped: history is the point of this file.
   */
  private loadEvents(): void {
    const path = join(this.directory, EVENTS_FILE)
    if (!existsSync(path)) return
    const text = readFileSync(path, 'utf8')
    if (text.length === 0) return
    const lines = text.split('\n')
    // A trailing newline yields an empty final element; its absence means the
    // last write was cut off.
    const torn = !text.endsWith('\n')
    const lastIndex = lines.length - 1
    lines.forEach((line, index) => {
      if (line.length === 0) return
      try {
        this.events.push(JSON.parse(line) as TaskEvent)
      } catch (error) {
        if (torn && index === lastIndex) return
        throw new Error(`${path} line ${index + 1} is not a valid event: ${String(error)}`)
      }
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
