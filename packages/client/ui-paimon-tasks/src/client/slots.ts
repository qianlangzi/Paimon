/**
 * The task strip's injected face.
 *
 * Only one verb: the strip is a read-only view of what the governance layer
 * already recorded. It deliberately cannot create, finish or abandon a task —
 * those are the model's decisions, and a UI that could make them would give a
 * human a second, unaudited path into the state machine.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskRowDto } from '@deepseek-ai/dsh-paimon-controller/types'
import type { PaimonTasksKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The task strip's copy. */
    paimonTasks: PaimonTasksKey
  }
}

/** What the strip asks the Host for. */
export interface PaimonTaskStripInjected {
  /** Current task rows, newest activity first. */
  readonly load: () => Promise<RemoteResult<readonly TaskRowDto[]>>
}
