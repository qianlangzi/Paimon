---
description: "Paimon task strip: one row in the conversation input dock showing how many tasks are open, how many are running, and whether any is waiting for a human decision, read over the generated `paimonTask` Remote namespace."
kind: "package-reference"
---
# Paimon Task Strip

## Summary

`@deepseek-ai/dsh-client-ui-paimon-tasks` contributes one entry to `conversation.input.dock`: a single line that answers *is anything still running, and does anything need me?* It reads the task list through `ctx.remote.paimonTask.list()` — the generated Remote namespace of `@deepseek-ai/dsh-paimon-controller` — and polls it on an interval rather than subscribing.

It is the first view of M5 (`docs/Paimon-M5-Plan.md`, S4). The full list/detail/approval/diagnostics panels remain future work; this strip is the smallest surface that makes the governance layer visible without leaving the conversation.

## Use this package

The plugin requires `slots`, `remote`, `remote.paimonTask`, `locale` and `uiConversation`, and is declared with `platform: "web"` plus a `dsh.client.inject` list, so the browser bundle picks it up from the manifest. It is mounted by `packages/bundle/web-app/cordis.patch.yml`.

Behaviour worth knowing:

- **Nothing renders** while the first read is in flight, when no task exists, or when the list is empty. The input dock is shared with other surfaces and an empty strip is noise.
- **One failure mode is visible**: a failed read shows the message and a refresh control instead of silently pretending there are no tasks. "Could not ask" and "nothing to show" are different facts.
- **Polling, not streaming.** The list changes on the scale of tool calls, and a poll cannot leak a subscription when the strip unmounts. `REFRESH_INTERVAL_MS` is exported so a test can shorten it.
- **Read-only by construction.** The strip cannot create, finish, abandon or cancel a task: those are the model's decisions, and a UI that could make them would be a second, unaudited path into the state machine.

Copy lives in `src/client/locales.ts` with `zh` and `en`; the `paimonTasks` namespace is merged into `LocaleNamespaceMap` as a key union, so a typo in a component is a compile error rather than a runtime fallback.

## Known Limitations and Deferred Work

- No interaction beyond refresh: selecting a task to open its detail is S5 work, together with the approval inbox.
- The strip shows the newest task only. Ordering comes from the Host (`updatedAt` descending) so two surfaces cannot disagree about "most recent".
- No browser-level verification yet: the component is covered by jsdom tests and the client bundle builds, but running `dsh web` against this fork's local packages is not wired (the web profile resolves published packages, and the local `apps/web` dist is unbuilt).
