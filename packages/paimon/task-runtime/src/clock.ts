/**
 * Time source. Injected everywhere so deadline and retry tests are
 * deterministic without patching globals.
 */
export interface Clock {
  now(): number
}

/** Wall-clock source backed by `Date.now()`. */
export const systemClock: Clock = {
  now: () => Date.now(),
}

/** A clock that only moves when a test tells it to. */
export interface ManualClock extends Clock {
  advance(ms: number): void
  set(epochMs: number): void
}

/** Creates a deterministic clock starting at `startEpochMs`. */
export function createManualClock(startEpochMs = 0): ManualClock {
  let current = startEpochMs
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
    set: (epochMs: number) => { current = epochMs },
  }
}

/** Renders a clock reading as the ISO timestamp stored on domain objects. */
export function toIso(clock: Clock): string {
  return new Date(clock.now()).toISOString()
}
