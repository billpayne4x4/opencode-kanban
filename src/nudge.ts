/**
 * The nudge engine.
 *
 * The problem it solves: an agent that stops mid-task with work left on the
 * board is usually *paused*, not *finished*. Restarting it is helpful. But the
 * other reading is that the human hit stop on purpose, and restarting that is
 * the single most annoying thing a tool can do.
 *
 * We cannot tell those two apart. So we take the cheap, recoverable action a
 * bounded number of times and then assume the human meant it: nudge up to
 * `maxAttempts` times, then halt and say so out loud. The human can always
 * resume; the cost of guessing wrong is three short prompts, the cost of not
 * halting is ignoring a stop button forever.
 *
 * Every function here is pure. The caller decides when to poll.
 */

import { type Board, type Item, type NudgeState, freshNudge } from "./types.ts"
import { hasOpenWork, madeProgress, nextItem } from "./board.ts"

/** Three tries, then assume the human wants to stop. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** What the composer looked like at decision time. */
export type ComposerState = {
  /** True when the prompt input owns focus. */
  focused: boolean
  /** Whatever the human has typed so far. */
  input: string
}

export type NudgeOptions = {
  maxAttempts?: number
  /**
   * The human is mid-sentence. Never nudge into a half-typed message: the
   * nudge would race the input and spend tokens on something nobody asked for.
   *
   * This is the cross-process form — the TUI plugin cannot observe the
   * composer from the server, so it records a boolean on the board and the
   * controller reads it here.
   */
  composerBusy?: boolean
  /**
   * Richer in-process form, for a caller that can see the prompt directly.
   * Takes precedence over `composerBusy` when present.
   */
  composer?: ComposerState
  /** Set by tests; defaults to the wall clock. */
  now?: number
}

export type NudgeDecision = {
  /** True when the caller should send a prompt. */
  fire: boolean
  /** Why we decided this way. Shown in the panel, asserted in tests. */
  reason: string
  /** Nudge state to persist — may already be halted even when `fire` is false. */
  nudge: NudgeState
  /** The item the prompt should point at, when `fire` is true. */
  item?: Item
}

/** The nudge prompt. A bare id is enough: `kanban_read` returns the rest. */
export function nudgeText(item: Item): string {
  return `kanban task ${item.id}`
}

/** A human who is typing gets priority over our impatience. */
export function composerBlocksNudge(composer: ComposerState | undefined): boolean {
  if (!composer) return false
  return composer.focused && composer.input.trim().length > 0
}

/** Progress on the board clears the attempt counter. */
export function noteProgress(nudge: NudgeState): NudgeState {
  return { ...nudge, attempts: 0, halted: false }
}

/**
 * Apply the progress rule to a mutation.
 *
 * Any path that marks an item done — the agent's tool, a TUI dialog, a
 * reorder that reveals a finished item — goes through here, so "an item
 * reached done resets the counter" has exactly one implementation. That
 * matters: the counter is the only thing standing between three nudges and a
 * halt, and a second code path quietly skipping the reset is how you get a
 * spurious halt.
 */
export function withProgressPolicy(prev: Board, next: Board): Board {
  return madeProgress(prev, next) ? { ...next, nudge: noteProgress(next.nudge) } : next
}

/** Human pressed pause. */
export function pause(nudge: NudgeState): NudgeState {
  return { ...nudge, paused: true }
}

/** Human took the board off autopilot but did not reset the counter. */
export function unpause(nudge: NudgeState): NudgeState {
  return { ...nudge, paused: false }
}

/** Human said "carry on" after a halt. */
export function resume(nudge: NudgeState): NudgeState {
  return { ...nudge, paused: false, attempts: 0, halted: false, lastResult: "resumed by user" }
}

/**
 * Decide whether to nudge. Pure: same board in, same decision out.
 *
 * Check order is the contract, and it is deliberately:
 *
 *  1. paused            — a human instruction outranks our policy
 *  2. no open work      — nothing to restart *for*; also clears the counter
 *  3. halted            — we already assumed a human stop
 *  4. cap reached       — a persisted counter at the cap halts here
 *  5. composer busy     — do not race a half-typed message
 *  6. fire
 */
export function decideNudge(board: Board, options: NudgeOptions = {}): NudgeDecision {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const now = options.now ?? Date.now()
  const nudge = board.nudge ?? freshNudge()

  if (nudge.paused) {
    return { fire: false, reason: "paused by user", nudge: { ...nudge, lastResult: "paused by user" } }
  }

  if (!hasOpenWork(board)) {
    // Finishing the work is the clearest possible progress signal: restart the
    // counter so the next board starts clean without the human doing anything.
    const cleared = noteProgress({ ...nudge, lastResult: "board complete" })
    return { fire: false, reason: "board complete", nudge: cleared }
  }

  if (nudge.halted) {
    return {
      fire: false,
      reason: `halted after ${nudge.attempts} attempt(s) — assuming you wanted to stop`,
      nudge: { ...nudge, lastResult: "halted" },
    }
  }

  if (nudge.attempts >= maxAttempts) {
    const halted = { ...nudge, halted: true, lastResult: "attempt cap reached" }
    return { fire: false, reason: `attempt cap reached (${maxAttempts}) — assuming you wanted to stop`, nudge: halted }
  }

  const busy = options.composer ? composerBlocksNudge(options.composer) : options.composerBusy === true
  if (busy) {
    return {
      fire: false,
      reason: "you are typing — not interrupting",
      nudge: { ...nudge, lastResult: "composer busy" },
    }
  }

  const item = nextItem(board)
  if (!item) {
    return { fire: false, reason: "no item to point at", nudge: { ...nudge, lastResult: "no item" } }
  }

  const attempts = nudge.attempts + 1
  const next: NudgeState = {
    ...nudge,
    attempts,
    // Halt the moment the last permitted attempt is spent, so the *next* idle
    // event is quiet. Three nudges means three nudges, not three then a fourth.
    halted: attempts >= maxAttempts,
    lastNudgeAt: now,
    lastResult: `nudge ${attempts}/${maxAttempts}`,
  }
  return { fire: true, reason: next.lastResult ?? "nudging", nudge: next, item }
}

/** One-line status for the panel header. */
export function nudgeLabel(nudge: NudgeState, maxAttempts = DEFAULT_MAX_ATTEMPTS): string {
  if (nudge.paused) return "paused"
  if (!nudge.halted && nudge.attempts === 0) return "idle"
  if (nudge.halted) return `halted ${nudge.attempts}/${maxAttempts}`
  return `nudge ${nudge.attempts}/${maxAttempts}`
}