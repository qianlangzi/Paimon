/**
 * Paimon task strip plugin, browser half: one entry in the conversation input
 * dock.
 *
 * The data arrives through the generated `paimonTask` Remote namespace, so this
 * plugin needs no projection, no event subscription and no Host-side state of
 * its own — the governance layer is already the record, and a second copy in
 * the browser would be one more thing to desynchronise.
 *
 * @module @deepseek-ai/dsh-client-ui-paimon-tasks/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the generated Remote API and the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Conversation service and the input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `paimonTasks` locale namespace and TaskRowDto import paths.
import type {} from './slots.ts'
import { PaimonTaskStrip } from './PaimonTaskStrip.tsx'
import { NS, en, zh } from './locales.ts'

export { PaimonTaskStrip } from './PaimonTaskStrip.tsx'
export type { PaimonTaskStripProps } from './PaimonTaskStrip.tsx'
export type { PaimonTaskStripInjected } from './slots.ts'
export { REFRESH_INTERVAL_MS } from './PaimonTaskStrip.tsx'

/** Required services: the dock slot, the generated namespace, and copy. */
export const inject = ['slots', 'remote', 'remote.paimonTask', 'locale', 'uiConversation']

/**
 * Client plugin body: the task strip's dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-paimon-tasks: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'paimon-tasks',
    order: 20,
    locale: NS,
    // Both reads are handed over unstarted: the strip loads on its own schedule
    // and only fetches a detail when a human opens a row, so resolving either
    // here would make the dock wait on the network for something nobody asked
    // for yet.
    inject: () => ({
      load: () => ctx.remote.paimonTask.list(),
      loadDetail: (taskId, eventLimit) => ctx.remote.paimonTask.detail(taskId, eventLimit),
    }),
  }, PaimonTaskStrip))
}
