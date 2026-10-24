---
description: "Paimon task governance layer: task and run lifecycle, bounded retry, deadline coordination and evidence-based completion. Read this when extending Paimon's own domain rules rather than the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-paimon-task-runtime

[中文](README.zh.md) | English

## Overview

The harness already owns the agent loop, the tool execution pipeline, the approval seam, the sandbox and the append-only session log. What it does not own is a **task**: a user goal that outlives a single turn, ends in a verified terminal state, and can be retried a bounded number of times.

This package supplies exactly that layer and nothing else. It has **no import of DSH or Cordis anywhere**, which is deliberate: the domain rules must be testable without booting a harness, and they must not be able to depend on harness internals by accident.

## Why this exists

An audit of the upstream tree found no task lifecycle at all — searching every `packages/*/src` for `TaskStatus`, `interface Task` or `taskId` returns nothing. The harness organises work as `Session -> Turn -> Step`. That is the right shape for a conversation and the wrong shape for a goal, because:

- A turn cannot express "this goal is still unfinished after four attempts".
- A step cannot distinguish *the run failed* from *the task failed*.
- Nothing decides whether the work is actually done; only the model says so.

Four things therefore belong to Paimon rather than to the harness: the task state machine, the run record with a retry budget, task-level deadline coordination, and evidence-based completion.

## Use this package

```ts
import {
  TaskRuntime,
  testReportRule,
  type Evidence,
} from '@deepseek-ai/dsh-paimon-task-runtime'

const runtime = new TaskRuntime({ knownSecrets: [process.env.API_KEY ?? ''] })

const task = runtime.createTask({
  goal: 'make the failing test pass',
  workspace: '/repo/project',
  deadlineMs: 10 * 60_000,
  rules: [testReportRule({ id: 'tests', description: 'unit tests pass' })],
})

runtime.startRun(task.id)

// Gate every side-effecting call before it happens.
const gate = runtime.gateToolCall(task.id, { toolId: 'bash', path: '/repo/project/src/a.ts' })
if (gate.kind !== 'allow') return

const evidence: Evidence[] = [
  { id: 'e1', kind: 'test-report', ref: 'suite:unit', passed: true, detail: '42 passed' },
]

const outcome = runtime.completeRun(task.id, evidence, 'tests green')
if (outcome.kind === 'succeeded') {
  // The task is SUCCEEDED and the report is attached to finalResult.
}
```

### Lifecycle

```text
PENDING -> RUNNING -> WAITING_APPROVAL -> RUNNING
                  \-> SUCCEEDED | FAILED | CANCELLED | TIMED_OUT
```

Every terminal status has an empty transition list, so `SUCCEEDED -> RUNNING`, `CANCELLED -> RUNNING` and `TIMED_OUT -> SUCCEEDED` are structurally impossible rather than merely discouraged.

### Retrying

A failed **run** does not fail the **task** while retry budget remains. The task stays `RUNNING` and the next `startRun` appends attempt `n + 1`; the previous run keeps its terminal status forever. The task only reaches `FAILED` when the budget is spent, so no task ever has to be resurrected to represent a retry.

`decideRetry` evaluates in a fixed order: cancellation first, then an exhausted deadline, then the failure class, then the attempt budget. Cancellation wins over everything, which is how "a refusal cannot be routed around by retrying" is enforced by structure instead of by convention.

### Cancelling

`requestCancel` records intent and changes nothing else. `acknowledgeCancel` is the only method that moves the status to `CANCELLED`. Keeping them separate is what lets a caller honestly report "cancel requested, execution not yet stopped".

### Verifying

`ResultValidator` refuses to treat a `model-claim` as evidence. A claim is filtered out before any rule runs, so a task whose only support is the model saying "it works" reports `not-checked`, never `passed`. A task with no configured rules can never be satisfied.

### Redaction

Every recorded event passes through `redactRecord`. Fields whose names look like credentials are replaced, and caller-supplied `knownSecrets` are scrubbed from free text. Traversal is depth-limited and cycle-safe, because redaction runs on the logging path and must not be the reason a task dies.

## Known Limitations and Deferred Work

- **Lexical workspace boundary.** `checkWithinWorkspace` normalises and compares path segments; it cannot see that `workspace/link` points at `/etc`. Callers needing that guarantee must `fs.realpath` both paths first. Stated here rather than silently implied.
- **In-memory persistence only.** `MemoryTaskStore` is not durable. `TaskStore` is the port a SQLite or JSONL adapter implements later.
- **No harness adapter yet.** Nothing wires `tools/pre-execute` to `gateToolCall` or `session/event` to `TaskEvent`. That adapter is the next milestone; this package stays harness-agnostic until it exists.
- **Single active run.** The runtime assumes one run at a time per task. Parallel attempts would need a scheduling rule the PRD does not yet define.
- **No cross-process coordination.** Deadlines are evaluated when the runtime is asked, not by a timer. A caller that never calls `enforceDeadline` or `gateToolCall` will observe a stale status.
- **Deviates from upstream release gates.** This package is `private: true` and does not declare the upstream repository URL, so `pnpm run constraints` will flag it. It is Paimon code living in a forked tree, not an upstream release member.
