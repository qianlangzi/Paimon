---
description: "Host-side read model for the Paimon desktop surfaces: task rows and task details in the shapes a view renders, plus the DTO boundary that keeps the UI off the governance layer's internal types."
kind: "package-reference"
---
# Paimon Controller

## Summary

`@deepseek-ai/dsh-paimon-controller` owns the Host `ctx.paimonTask` service. It answers the two questions every Paimon view asks — *what tasks are there* and *what happened in this one* — by projecting `ctx.paimonTasks` into DTOs (`TaskRowDto`, `TaskDetailDto`) that carry only what a view draws. It is step S1 of `docs/Paimon-M5-Plan.md`; the remote contract (`ctx.remote.paimonTask`) is generated from this service in S2.

It is read-only on purpose. Cancel and abandon are writes with governance consequences, and a read model that could also mutate state would become a second place that decides transitions.

## Use this package

The controller requires `paimonTasks` (from `@deepseek-ai/dsh-paimon-task-harness`) and does not activate without it: an empty list must mean "no tasks", never "the adapter is missing".

- `list()` — every recorded task, sorted by `updatedAt` descending, with `needsApproval` already computed from the state machine.
- `detail(taskId, eventLimit?)` — one task with its runs and timeline. `eventLimit` defaults to 200; a long task can hold thousands of events and a panel only ever shows the tail.

DTO rules worth keeping:

- The domain `Task` is never sent across the boundary. Adding a field to it must not be a UI change.
- Failure classes travel (`errorKind`), failure messages do not — the timeline already carries the redacted detail.
- A task that has been probed but has not finished still gets a `validation` block, rebuilt from the last `validation/completed` event.

## Known Limitations and Deferred Work

- No remote contract yet: this is S1. Nothing in a profile mounts the package, so it is reachable from the Host and from tests only.
- No write operations. `cancel` / `abandon` arrive with the approval inbox in S5, where a human acts.
- `Task` records no owning session, so a row cannot say which conversation created it. Adding `sessionId` is a domain change and is deliberately not smuggled in here.
- The rebuilt `validation` from an event has no per-check description; the check id is used instead. The final report, when it exists, carries the real description.
