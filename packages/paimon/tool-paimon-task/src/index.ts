/**
 * Model-facing Paimon task tools.
 *
 * Five controls over the task governance layer: create, inspect, list, attempt
 * to finish, and abandon. The finish control deliberately cannot assert success
 * — it asks the validator, and only observed evidence decides. That keeps the
 * model's agency (it chooses when to check) separate from its authority (it
 * cannot declare the work verified). Abandon is the deliberate opposite: it
 * closes a task as failed, so dropping a goal always leaves a record.
 *
 * @module @deepseek-ai/dsh-tool-paimon-task
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-paimon-task-harness'
import { ApprovalPendingError, isTerminalTaskStatus } from '@deepseek-ai/dsh-paimon-task-runtime'
import {
  type CompletionMode,
  COMPLETION_MODES,
  DEFAULT_COMPLETION_MODE,
  completionRuleSpecs,
} from './completion.ts'
import {
  type EventSummary,
  type ReportSummary,
  type TaskRow,
  type TaskSummary,
  renderReport,
  renderSummary,
  renderTaskList,
  renderTimeline,
  reportSummary,
  taskRow,
  taskSummary,
} from './view.ts'

export const name = 'tool-paimon-task'

/** The task service supplies both the runtime and the agent bindings. */
export const inject = ['tools', 'paimonTasks']

/** How many timeline entries `paimon_task_status` returns. */
const MAX_EVENTS = 20

const TASK_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    goal: { type: 'string', required: true },
    status: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    cancelRequested: { type: 'boolean', required: true },
    workspace: { type: 'string' },
    deadlineMs: { type: 'number' },
    outcome: { type: 'string' },
  },
} as const

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    satisfied: { type: 'boolean', required: true },
    checks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
    },
  },
} as const

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true },
    timestamp: { type: 'string', required: true },
  },
} as const

const STATUS_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { ...TASK_SUMMARY_SCHEMA, required: true },
    events: { type: 'array', required: true, items: EVENT_SCHEMA },
    validation: REPORT_SCHEMA,
  },
} as const

const FINISH_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    completed: { type: 'boolean', required: true },
    status: { type: 'string', required: true },
    report: { ...REPORT_SCHEMA, required: true },
    note: { type: 'string' },
  },
} as const

const TASK_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', required: true },
    goal: { type: 'string', required: true },
    status: { type: 'string', required: true },
    attempt: { type: 'integer', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    outcome: { type: 'string' },
  },
} as const

const LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_ROW_SCHEMA },
  },
} as const

/** How many tasks `paimon_task_list` returns when the caller does not say. */
const DEFAULT_LIST_LIMIT = 20

const CREATE_DESCRIPTION =
  'Create a Paimon task for the current work and start its first attempt. '
  + 'A task is a goal that outlives this turn: it has a terminal state, a bounded retry budget, '
  + 'and a completion condition that only observed evidence can satisfy. '
  + 'Use it when the request is a goal rather than a single question. '
  + 'A workspace is required; tool calls touching paths outside it are denied.'

const STATUS_DESCRIPTION =
  'Read the current Paimon task: status, attempt count, recent events and the completion checks. '
  + 'Use it before paimon_task_finish to see which evidence is still missing.'

const FINISH_DESCRIPTION =
  'Check the current task against the evidence observed so far and close it only if every condition passes. '
  + 'This does not assert success: if a condition is unmet the task stays open and the unmet checks are returned '
  + 'so you can keep working. Only observed tool evidence counts, never your own description of the result.'

const LIST_DESCRIPTION =
  'List recorded Paimon tasks, most recently updated first. '
  + 'Use it to see what is still open, including tasks left behind by an earlier session, '
  + 'before deciding whether to resume or abandon them.'

const ABANDON_DESCRIPTION =
  'Close a task as failed because the goal is being dropped, and record why. '
  + 'Use it instead of paimon_task_finish when the work will not be completed, and to clear a task that a '
  + 'previous session left open. Abandoning does not claim the work succeeded.'

/** Rejects a call with no calling agent, which would have no task to act on. */
function requireAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('paimon task tools require a calling agent')
  }
  return agent
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Registers the task controls. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'paimon_task_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'The concrete completion objective, in one sentence.',
      },
      workspace: {
        type: 'string',
        required: true,
        description: 'Absolute path of the directory this task may modify. Paths outside it are denied.',
      },
      deadline_ms: {
        type: 'number',
        description: 'Optional positive wall-clock budget in milliseconds for the whole task. '
          + 'Omit it for no budget; a task without one never times out.',
      },
      completion: {
        type: 'string',
        enum: [...COMPLETION_MODES],
        description: 'How completion is verified. "auto" (default) uses "tests" when this deployment '
          + 'declares a test runner and "tool-success" otherwise, so a task is never created with a '
          + 'condition this deployment cannot check. "tests" requires a passing test run; '
          + '"tool-success" only requires that some tool call succeeded.',
      },
    },
    output: {
      schema: TASK_SUMMARY_SCHEMA,
      render: (_args: unknown, value: TaskSummary) => [{ type: 'text' as const, text: renderSummary(value) }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec)
      const mode = (args.completion ?? DEFAULT_COMPLETION_MODE) as CompletionMode
      const rules = completionRuleSpecs(mode, {
        hasTestTools: ctx.paimonTasks.testTools.length > 0,
      })
      const task = ctx.paimonTasks.bind(agent, {
        goal: args.goal,
        workspace: args.workspace,
        ruleSpecs: rules,
        ...args.deadline_ms === undefined ? {} : { deadlineMs: args.deadline_ms },
      })
      let run
      try {
        run = ctx.paimonTasks.runtime.startRun(task.id)
      } catch (error) {
        // The binding is already in place, and a task whose first attempt never
        // started has no deadline to expire it. Leaving it would wedge the
        // agent: every later create would be refused as "already bound" and the
        // orphan could never be closed. Abandoning it releases both.
        ctx.paimonTasks.abandon(task.id, `the first attempt could not start: ${messageOf(error)}`)
        throw error
      }
      return Promise.resolve(
        taskSummary(ctx.paimonTasks.runtime.getTask(task.id), [run]),
      )
    },
    presentCall: args => present('Create task', 'other', args.goal),
  }))

  ctx.tools.register(defineTool({
    name: 'paimon_task_status',
    description: STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: STATUS_VALUE_SCHEMA,
      render: (_args: unknown, value: StatusValue) => {
        const lines = [renderSummary(value.task)]
        if (value.validation !== undefined) lines.push('', renderReport(value.validation))
        lines.push('', 'recent events:', renderTimeline(value.events))
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    execute(_args, exec) {
      const agent = requireAgent(exec)
      const task = ctx.paimonTasks.taskOf(agent)
      if (task === undefined) {
        throw new Error('this agent has no Paimon task; call paimon_task_create first')
      }
      const runs = ctx.paimonTasks.runtime.listRuns(task.id)
      const events: EventSummary[] = ctx.paimonTasks.runtime.getEvents(task.id)
        .slice(-MAX_EVENTS)
        .map(event => ({ type: event.type, timestamp: event.timestamp }))
      const finalReport = task.finalResult?.validation
      return Promise.resolve({
        task: taskSummary(task, runs),
        events,
        ...finalReport === undefined ? {} : { validation: reportSummary(finalReport) },
      })
    },
    presentCall: () => present('Read task status', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'paimon_task_finish',
    description: FINISH_DESCRIPTION,
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: 'What was actually done, for the task report. Does not affect verification.',
      },
    },
    output: {
      schema: FINISH_VALUE_SCHEMA,
      render: (_args: unknown, value: FinishValue) => [{
        type: 'text' as const,
        text: value.note !== undefined
          ? `Task still open (${value.status}). ${value.note}`
          : value.completed
            ? `Task ${value.status}. ${renderReport(value.report)}`
            : `Task still open (${value.status}). ${renderReport(value.report)}`,
      }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec)
      const service = ctx.paimonTasks
      const task = service.taskOf(agent)
      if (task === undefined) {
        throw new Error('this agent has no Paimon task; call paimon_task_create first')
      }
      const evidence = service.bindings.evidenceOf(agent)
      // A finished task has no active run, so settling it again would throw.
      // Answering with the recorded result is what the caller actually wants
      // and keeps a second finish call from looking like a failure.
      if (isTerminalTaskStatus(task.status)) {
        const recorded = task.finalResult?.validation
        return Promise.resolve({
          completed: task.status === 'SUCCEEDED',
          status: task.status,
          report: recorded === undefined ? { satisfied: false, checks: [] } : reportSummary(recorded),
          note: 'this task has already finished; the report above is its recorded outcome',
        })
      }
      let report
      try {
        // Probe first: a failing check must leave the task open rather than
        // close the run, so a model that checks too early can keep working.
        report = service.runtime.checkCompletion(task.id, evidence)
      } catch (error) {
        // A task parked for a human decision cannot be verified yet. That is a
        // state, not a failure of the call, so it is reported rather than
        // thrown: the model should wait, not retry blindly.
        if (error instanceof ApprovalPendingError) {
          return Promise.resolve({
            completed: false,
            status: task.status,
            report: { satisfied: false, checks: [] },
            note: 'the task is waiting for a human approval decision; nothing can be verified until it is made',
          })
        }
        throw error
      }
      if (!report.satisfied) {
        return Promise.resolve({
          completed: false,
          status: task.status,
          report: reportSummary(report),
        })
      }
      const outcome = service.runtime.completeRun(task.id, evidence, args.summary)
      return Promise.resolve({
        completed: outcome.kind === 'succeeded',
        status: service.runtime.getTask(task.id).status,
        report: reportSummary(report),
      })
    },
    presentCall: () => present('Finish task', 'other'),
  }))

  ctx.tools.register(defineTool({
    name: 'paimon_task_list',
    description: LIST_DESCRIPTION,
    parameters: {
      limit: {
        type: 'number',
        description: 'How many tasks to return, newest first. Defaults to 20.',
      },
    },
    output: {
      schema: LIST_VALUE_SCHEMA,
      render: (_args: unknown, value: ListValue) => [{
        type: 'text' as const,
        text: renderTaskList(value.tasks),
      }],
    },
    execute(args) {
      const limit = args.limit === undefined ? DEFAULT_LIST_LIMIT : Math.max(1, Math.trunc(args.limit))
      const rows = ctx.paimonTasks.runtime.listTasks()
        .map(taskRow)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
      return Promise.resolve({ tasks: rows })
    },
    presentCall: () => present('List tasks', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'paimon_task_abandon',
    description: ABANDON_DESCRIPTION,
    parameters: {
      reason: {
        type: 'string',
        required: true,
        description: 'Why the goal is being dropped. Recorded in the task timeline.',
      },
      task_id: {
        type: 'string',
        description: 'Task to abandon. Defaults to this agent\'s task.',
      },
    },
    output: {
      schema: TASK_SUMMARY_SCHEMA,
      render: (_args: unknown, value: TaskSummary) => [{ type: 'text' as const, text: renderSummary(value) }],
    },
    execute(args, exec) {
      const agent = requireAgent(exec)
      const service = ctx.paimonTasks
      const taskId = args.task_id ?? service.taskOf(agent)?.id
      if (taskId === undefined) {
        throw new Error('this agent has no Paimon task; pass task_id to abandon another one')
      }
      const abandoned = service.abandon(taskId, args.reason)
      return Promise.resolve(taskSummary(abandoned, service.runtime.listRuns(abandoned.id)))
    },
    presentCall: args => present('Abandon task', 'other', args.reason),
  }))
}

/** Shape of `paimon_task_status`'s canonical value. */
interface StatusValue {
  readonly task: TaskSummary
  readonly events: EventSummary[]
  readonly validation?: ReportSummary
}

/** Shape of `paimon_task_finish`'s canonical value. */
interface FinishValue {
  readonly completed: boolean
  readonly status: string
  readonly report: ReportSummary
  /** Present when the call was refused for a reason rather than answered. */
  readonly note?: string
}

/** Shape of `paimon_task_list`'s canonical value. */
interface ListValue {
  readonly tasks: TaskRow[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
