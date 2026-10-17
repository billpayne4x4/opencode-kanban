/**
 * Shared types for the kanban board.
 *
 * Two things live on a board and they are deliberately kept apart:
 *
 * - `items` is the work. The agent writes it through the `kanban_write` tool,
 *   the human edits it through dialogs, and both see the same list.
 * - `nudge` is the restart policy. It is bookkeeping about *how hard we are
 *   trying to wake the agent up*, not about the work itself, so it never
 *   leaks into item text and never needs the agent's help to stay correct.
 *
 * A board is scoped to one session. Worktrees and experiments stay separate
 * because they have genuinely separate next steps.
 */

/** Where an item sits in its lifecycle. */
export type ItemStatus = "pending" | "in_progress" | "done" | "blocked"

/** One task on the board. */
export type Item = {
  id: string
  title: string
  /**
   * The body of the task: acceptance criteria, the procedure, the links.
   * This is what makes a bare `kanban task <id>` nudge sufficient — the agent
   * reads this on demand instead of the nudge having to inline the whole thing.
   */
  detail?: string
  status: ItemStatus
  /**
   * The containing folder, if any. Absent means top level.
   *
   * A parent is a container, not a unit of work: it has no status of its own
   * and completes when every descendant does. That is what makes "Port the
   * compiler" a heading rather than a task you can never tick.
   */
  parentID?: string
  createdAt: number
  updatedAt: number
}

/**
 * Restart policy state.
 *
 * `attempts` counts consecutive nudges that produced no progress. Progress —
 * an item reaching `done` — resets it, because that is the signal that
 * distinguishes "agent stopped and needs a continue" from "agent is working".
 */
export type NudgeState = {
  attempts: number
  /** True once attempts hit the cap: we assume the *human* wants to stop. */
  halted: boolean
  /** Set by the human. Never cleared by the agent. */
  paused: boolean
  /**
   * Master switch for the restart policy. Optional so an absent value means
   * "on" — a board written before this field existed keeps nudging rather than
   * silently going quiet.
   */
  enabled?: boolean
  /**
   * How many nudges before halting. Optional for the same reason: absent means
   * the default, which keeps old boards working.
   */
  maxAttempts?: number
  lastNudgeAt?: number
  /** Why we last decided, in words. Shown in the panel; asserted in tests. */
  lastResult?: string
}

/** One session's board. */
export type Board = {
  sessionID: string
  name: string
  items: Item[]
  /** The item the agent is currently on. */
  currentID?: string
  nudge: NudgeState
  updatedAt: number
  /**
   * Transient, written by the TUI plugin: true while the human has focus and
   * has typed something. The server-side controller reads it so a nudge never
   * races a half-typed message. Not part of the work list, and safe to lose.
   */
  composerBusy?: boolean
  /**
   * Debug logging on/off. Optional so a board written before this field
   * existed stays quiet rather than logging forever.
   */
  debug?: boolean
  /**
   * Where changes are announced: a toast, or a coloured block in the window.
   *
   * A board field rather than a plugin option, because options are read once at
   * load and someone switching this off mid-session wants it to stick without
   * editing a config file. Optional so an older board falls back to the option.
   */
  notify?: "toast" | "panel"
}

/** An empty nudge state — the starting point for every board. */
export function freshNudge(): NudgeState {
  return { attempts: 0, halted: false, paused: false }
}

/** An empty board for `sessionID`. */
export function freshBoard(sessionID: string, name = "Board"): Board {
  const now = Date.now()
  return { sessionID, name, items: [], nudge: freshNudge(), updatedAt: now }
}