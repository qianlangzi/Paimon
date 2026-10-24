/**
 * Model-facing Paimon task tools.
 *
 * Three controls over the task governance layer: create, inspect, and attempt
 * to finish. The finish control deliberately cannot assert success — it asks
 * the validator, and only observed evidence decides. That keeps the model's
 * agency (it chooses when to check) separate from its authority (it cannot
 * declare the work verified).
 *
 * @module @deepseek-ai/dsh-tool-paimon-task
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-paimon-task-harness'
import {
  type CompletionMode,
  COMPLETION_MODES,
  DEFAULT_COMPLETION_MODE,
  completionRules,
} from './completion.ts'
import {
  type EventSummary,
  type ReportSummary,
  type TaskSummary,
  renderReport,
  renderSummary,
  renderTimeline,
  reportSummary,
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
  },
} as const

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

/** Registers the three task controls. */
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
        description: 'Optional wall-clock budget for the whole task. Without one the task never times out.',
      },
      completion: {
        type: 'string',
        enum: [...COMPLETION_MODES],
        description: 'How completion is verified. "tests" requires a passing test run; '
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
      const task = ctx.paimonTasks.bind(agent, {
        goal: args.goal,
        workspace: args.workspace,
        rules: completionRules(mode),
        ...args.deadline_ms === undefined ? {} : { deadlineMs: args.deadline_ms },
      })
      const run = ctx.paimonTasks.runtime.startRun(task.id)
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
        text: value.completed
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
      // Probe first: a failing check must leave the task open rather than
      // close the run, so a model that checks too early can keep working.
      const report = service.runtime.checkCompletion(task.id, evidence)
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
}
