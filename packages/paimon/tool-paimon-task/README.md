---
description: "Model-facing Paimon task controls: create a task, read its state, and attempt to finish it against observed evidence. Read this when changing what the model may do with a task."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-paimon-task

[中文](README.zh.md) | English

## Overview

Three model-facing controls over the task governance layer:

| Tool | Does |
|---|---|
| `paimon_task_create` | Creates a task, binds it to the calling agent, starts attempt 1 |
| `paimon_task_status` | Reports status, attempts, recent events and completion checks |
| `paimon_task_finish` | Checks the conditions against observed evidence and closes only if they pass |

## The line this package draws

**The model chooses when to check. It does not decide what counts.**

`paimon_task_finish` cannot assert success. It asks the validator, and the
validator only reads evidence the adapter observed from real tool results. A
model that writes "everything passes, trust me" in its summary gets
`completed: false` back, because a summary is not evidence.

`paimon_task_finish` also cannot *fail* a task by checking too early. It probes
first (`TaskRuntime.checkCompletion`) and leaves the run open when a condition
is unmet, so an agent that checks before finishing can keep working instead of
closing its own task by mistake.

## Completion modes

`paimon_task_create` requires a `completion` mode, because a task with no rule
can never be verified:

- **`tests`** (default) — needs a passing test report. Only exists when the
  deployment declares its test tools in `@deepseek-ai/dsh-paimon-task-harness`;
  an undeclared runner leaves the task unverifiable, which is the honest result
  rather than a rubber stamp.
- **`tool-success`** — only needs some tool call to have succeeded. Offered for
  tasks whose correctness is not machine-checkable, and deliberately not the
  default: it proves very little.

A richer policy language was rejected on purpose. Letting the model describe
its own success condition would hand it exactly the authority PRD 4.3/CODE-006
withholds.

## Use this package

```yaml
- name: '@deepseek-ai/dsh-paimon-task-harness'
  config:
    testTools: ['run_tests']
- name: '@deepseek-ai/dsh-tool-paimon-task'
```

The model then sees:

```text
paimon_task_create { goal, workspace, deadline_ms?, completion? }
paimon_task_status {}
paimon_task_finish { summary }
```

`workspace` is required rather than defaulted. A task with no workspace denies
every path-touching call, and silently substituting the process directory would
widen the boundary without the caller saying so.

## Known Limitations and Deferred Work

- **No abandon path.** A task with no deadline and no successful finish stays
  `RUNNING` indefinitely. Closing it needs an `abandoned` error kind in the
  domain model, which is deferred; until then, pass `deadline_ms`.
- **No task list or cancellation tool.** Only the calling agent's own task is
  reachable. Listing and cancelling from the model side would let it interfere
  with other sessions, so both wait for the UI milestone.
- **Evidence is per process.** Accumulated evidence lives in `TaskBindings`
  memory and is lost on restart, so a task cannot be resumed across a restart
  even though its state machine could express it.
- **No conversation structure in the timeline.** Events come from the tool
  pipeline only; turn and step boundaries are not projected yet.
- **One task per agent.** `paimon_task_create` fails when the agent is already
  bound, because rebinding would orphan a task with a live run.
