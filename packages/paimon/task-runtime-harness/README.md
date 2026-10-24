---
description: "Paimon harness adapter: binds tasks to agents and routes the tool pipeline, approval seam and cancellation through the task governance layer. Read this when connecting Paimon to the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-paimon-task-harness

[中文](README.zh.md) | English

## Overview

`@deepseek-ai/dsh-paimon-task-runtime` owns the task state machine, retry budget, deadline and evidence validation, and knows nothing about the harness. This package is the other half: it connects that layer to the harness's **existing** extension points without replacing any of them.

| Harness extension point | Becomes |
|---|---|
| `tools/pre-execute` waterfall | `TaskBindings.gate` → `PreToolDecision` |
| `ctx.approval` seam | `TaskBindings.resolveApproval` |
| `tools/result` observation | `TaskBindings.recordToolOutcome` → evidence |
| `agent.cancel` / `agent.whenIdle` | request/acknowledge cancellation |

The two decision vocabularies turn out to be nearly isomorphic — `allow`, `deny`, `ask`, `cancel` — which is why the adapter is thin rather than a parallel policy engine.

## The one safety property that matters

**An agent with no bound task is never touched.** Every routing method returns `undefined` when no task is bound, and the listener delegates unchanged. An adapter that silently invented a task for every session would change harness behaviour for users who never asked for it.

This is covered by four dedicated tests (`bindings: an unmanaged agent is never touched`).

## Use this package

```ts
// The plugin registers itself as ctx.paimonTasks.
const task = ctx.paimonTasks.bind(agent, {
  goal: 'make the failing test pass',
  workspace: '/repo/project',
  deadlineMs: 10 * 60_000,
  rules: [testReportRule({ id: 'tests', description: 'unit tests pass' })],
})

ctx.paimonTasks.runtime.startRun(task.id)

// Every tool call the agent makes is now gated. When the work is done:
const evidence = ctx.paimonTasks.bindings.evidenceOf(agent)
ctx.paimonTasks.runtime.completeRun(task.id, evidence, 'tests green')

// Stopping: records the request, cancels the turn, acknowledges only once the
// agent is actually idle.
await ctx.paimonTasks.cancel(agent)
```

### Configuration

```yaml
- name: '@deepseek-ai/dsh-paimon-task-harness'
  config:
    approvalTools: ['bash']      # tools that need a human decision
    testTools: ['run_tests']     # tools whose success means tests passed
    pathArgumentKeys: ['path', 'file_path']
    deadlineMs: 600000
    knownSecrets: []
```

Every field defaults to the least surprising value: `approvalTools` is empty, so the adapter never starts prompting for tools the harness would have run silently.

### Approval is delegated, not reimplemented

The adapter asks `ctx.approval.request()` itself rather than returning `{kind:'ask'}` and letting the pipeline ask. That costs one extra hop but is the only way the task can sit in `WAITING_APPROVAL` — PRD 4.4/SEC-003 requires the pending decision to be a task state, not an invisible pause inside the pipeline.

Any delivery failure (including asking outside an open turn) is treated as a refusal. An approval that could not be asked is not granted.

## Known Limitations and Deferred Work

- **Task creation is programmatic.** There is no model-facing tool and no UI to create a task yet; a caller must invoke `bind()` from code. A `paimon_task_create` tool is the next milestone.
- **`session/event` is not mapped.** Evidence comes from `tools/result` only. Turn and step boundaries are not yet projected into the task timeline, so a task's history shows tool calls but not conversation structure.
- **The path boundary is lexical and narrow.** It applies only when a declared argument key holds a path. A shell tool whose command embeds a path is not covered, and symlinks are not resolved. Both are stated rather than implied.
- **Test evidence requires declaration.** `testTools` names the tools whose success counts as a passing test report. The adapter will not parse a report out of arbitrary output, so an undeclared test runner produces only `tool-result` evidence that no test rule accepts.
- **Evidence lives in memory.** `TaskBindings` accumulates evidence per task in a `Map`; a process restart loses it. Durable evidence needs the storage adapter milestone.
- **Requires the approval seam.** The plugin injects both `tools` and `approval`, so a deployment without `user-approval` will not activate it — a visible failure rather than a silent degradation.
- **One task per agent.** Rebinding is refused rather than replacing the first task, because replacing would orphan a task with a live run.
