// Browser-level acceptance for the task strip.
//
// Until now every Paimon surface was verified in jsdom against a stubbed
// client: the component was right, but nothing proved that the part that has
// never been seen — the generated `paimonTask` Remote namespace, served by a
// real Host over a real connection, rendered into the real dock — works at all.
// That is the gap this closes.
//
// No model is involved, on purpose. The strip is a *read* surface, so the Host
// side can create the tasks directly; the test then depends on neither provider
// credentials, nor the agent loop, nor the filesystem sandbox. Everything it
// asserts is produced by the same read model the product uses.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-paimon-task-harness'
import type {} from '@deepseek-ai/dsh-paimon-controller'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./paimon-task-strip.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/paimon/task-runtime-harness/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/paimon/paimon-controller/package.json', import.meta.url)),
  // The browser half is named by the shipped Web bundle, not by this overlay, so
  // its manifest has to be an anchor too: without it the scaffold's profile can
  // name the dock entry but cannot resolve the package, and the plugin is
  // dropped at import time with nothing in the UI to show for it.
  fileURLToPath(new URL('../../../packages/client/ui-paimon-tasks/package.json', import.meta.url)),
]

/** Goal of the task the test opens; also its chip's accessible name. */
const RUNNING_GOAL = 'E2E: one task that is still running'
/** Goal of the task that exists only to prove the count is read, not assumed. */
const PENDING_GOAL = 'E2E: a second task in the list'

describe('web e2e: paimon task strip', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })

    // Created before the page loads, so the strip's first read already sees
    // them. Waiting for the next poll instead would tie the test to a 15 s
    // timer and leave a race between "task exists" and "page mounted".
    const running = scaffold.ctx.paimonTasks.bind(
      { id: 'e2e-running-agent' },
      { goal: RUNNING_GOAL, workspace: scaffold.workspaceCwd },
    )
    scaffold.ctx.paimonTasks.runtime.startRun(running.id)
    scaffold.ctx.paimonTasks.bind(
      { id: 'e2e-pending-agent' },
      { goal: PENDING_GOAL, workspace: scaffold.workspaceCwd },
    )

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reads the list over the Remote namespace and opens one task record', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-paimon-strip'))

    // The chip's title is the whole goal: the visible label is truncated, so
    // asserting on it would test the truncation, not the data.
    const chip = page.locator(`button[title="${RUNNING_GOAL}"]`)
    await expect.poll(() => chip.count(), { timeout: 30_000 }).toBe(1)

    // Both tasks arrived: the count and the running tally come from the same
    // rows the chips render, so this catches a list that silently dropped one.
    await expect.poll(() => page.getByText('2 task(s)').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('1 running').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.locator(`button[title="${PENDING_GOAL}"]`).count()).toBe(1)

    await chip.click()
    const detail = page.locator('[data-testid="paimon-task-detail"]')
    await detail.waitFor({ timeout: 10_000 })

    // A record that opens but shows nothing would still "pass" a visibility
    // check, so the assertions go into the content the Host recorded.
    await expect.poll(() => detail.getByText('timeline').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => detail.getByText('attempt 1').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => detail.getByText('task/created').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => detail.getByText('run/started').count(), { timeout: 10_000 }).toBe(1)

    // The dock is shared with other surfaces; a React error here would be a
    // broken conversation, not a broken strip.
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
