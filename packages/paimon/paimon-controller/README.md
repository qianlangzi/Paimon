---
description: "Host-side read model for the Paimon desktop surfaces: task rows and task details in the shapes a view renders, plus the DTO boundary that keeps the UI off the governance layer's internal types."
kind: "package-reference"
---
# Paimon Controller

## Summary

`@deepseek-ai/dsh-paimon-controller` owns the Host `ctx.paimonTask` service and the generated `paimonTask` Remote namespace. It answers the two questions every Paimon view asks — *what tasks are there* and *what happened in this one* — by projecting `ctx.paimonTasks` into DTOs (`TaskRowDto`, `TaskDetailDto`) that carry only what a view draws. Steps S1 and S2 of `docs/Paimon-M5-Plan.md`: the Host half is written by hand, the wire half (`lib/typert.remote-client.d.ts`) is generated and must never be edited.

It is read-only on purpose. Cancel and abandon are writes with governance consequences, and a read model that could also mutate state would become a second place that decides transitions.

## Use this package

The controller requires `paimonTasks` (from `@deepseek-ai/dsh-paimon-task-harness`) and does not activate without it: an empty list must mean "no tasks", never "the adapter is missing".

- `list()` — every recorded task, sorted by `updatedAt` descending, with `needsApproval` already computed from the state machine.
- `detail(taskId, eventLimit?)` — one task with its runs and timeline. `eventLimit` defaults to 200 inside the method; a long task can hold thousands of events and a panel only ever shows the tail.

Remote-contract rules the generator enforces, learned the hard way (each one is a build error, not a warning):

- Remote parameters cannot have default values — apply the default inside the body.
- Every type on the boundary must be exported from a non-root type subpath, hence `./types`.
- The boundary cannot carry unconstrained data: `Record<string, unknown>` is rejected, so event payloads are flattened to scalars with JSON text for anything structured.
- Methods must be `async`: `Promise.resolve(f())` still throws synchronously when `f` throws, which a Remote caller cannot observe.

DTO rules worth keeping:

- The domain `Task` is never sent across the boundary. Adding a field to it must not be a UI change.
- Failure classes travel (`errorKind`), failure messages do not — the timeline already carries the redacted detail.
- A task that has been probed but has not finished still gets a `validation` block, rebuilt from the last `validation/completed` event.

## Known Limitations and Deferred Work

- No client half yet: `ctx.remote.paimonTask` types exist, but nothing in a browser consumes them until S3.
- No write operations. `cancel` / `abandon` arrive with the approval inbox in S5, where a human acts.
- `Task` records no owning session, so a row cannot say which conversation created it. Adding `sessionId` is a domain change and is deliberately not smuggled in here.
- The rebuilt `validation` from an event has no per-check description; the check id is used instead. The final report, when it exists, carries the real description.
