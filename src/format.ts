/**
 * Presentation helpers. Pure so the panel can be checked without a terminal.
 *
 * Colours are picked from the host theme by name (see `statusColor`); nothing
 * here hardcodes a colour so the plugin inherits whatever theme is active.
 */

import { type Board, type Item, type ItemStatus, type NudgeState } from "./types.ts"
import { containerDone, isFolder, nextItem, progress, treeRows } from "./board.ts"
import { boardStatus, isHalted, nudgeBudget, nudgeEnabled, nudgeLabel } from "./nudge.ts"

/** Theme token for an item's status. */
export function statusColor(status: ItemStatus): "success" | "info" | "warning" | "text" | "textMuted" {
  switch (status) {
    case "done":
      return "success"
    case "in_progress":
      return "info"
    case "blocked":
      return "warning"
    case "pending":
      return "textMuted"
  }
}

/** Glyph for an item's status. */
export function statusGlyph(status: ItemStatus): string {
  switch (status) {
    case "done":
      return "✓"
    case "in_progress":
      return "▸"
    case "blocked":
      return "!"
    case "pending":
      return "·"
  }
}

/**
 * The checkbox the panel draws for an item.
 *
 * `[x]` for anything finished, `[ ]` for everything else. Deliberately only
 * two states: a third one (`[>]` for in-progress) reads as a checkbox you
 * cannot click, and the one thing this column is for is "is it done".
 * The item the agent is on is marked separately, with a leading `▸`.
 */
export function checkbox(status: ItemStatus): string {
  return status === "done" ? "[x]" : "[ ]"
}

/** `OpenCode Kanban (2/5)` — the panel heading. */
export function panelTitle(done: number, total: number): string {
  return `OpenCode Kanban (${done}/${total})`
}

/**
 * A rule that spans the panel.
 *
 * OpenTUI has no divider element, so this is text drawn to the panel's measured
 * width. Sizing it to the heading instead looks accidental in a wide pane, and
 * a hardcoded column count breaks the moment the terminal is resized.
 */
export function panelRule(width: number): string {
  return "─".repeat(Math.max(1, Math.trunc(width)))
}

/** One cell of the status row: either a label or a separator dot. */
export type StatusCell =
  | { kind: "text"; value: string; tone: "normal" | "alert" }
  | { kind: "dot" }

/**
 * The line under the list, as labels separated by dots.
 *
 * Rendered by the panel as a single `space-between` row, which is what spaces
 * the dots evenly across whatever width it is given:
 *
 * ```text
 * idle    ·    nudge on    ·    3 tries
 * ```
 *
 * Everything a glance needs, because these are the three things you ask about
 * ("is it stuck?", "is it still poking?", "how many times will it try?"). The
 * counter appears whenever it is non-zero, so it is visible while it climbs
 * rather than only at the end.
 */
export function statusCells(board: Board | undefined): StatusCell[] {
  const nudge = board?.nudge
  const budget = nudgeBudget(nudge)
  const halted = isHalted(board)
  const attempts = nudge?.attempts ?? 0
  // Red follows the arithmetic, not the flag: "exhausted" is what 3/3 means,
  // and a red 0/3 would be crying wolf.
  const exhausted = attempts >= budget

  // Red is reserved for the one state you have to act on: the plugin gave up.
  // A board you stopped yourself is a normal state, and colouring it red would
  // train you to ignore the colour.
  const labels: { value: string; tone: "normal" | "alert" }[] = [
    // Red only when the stop came from the nudges running out. A stop you
    // asked for is a normal state and reads as one.
    { value: boardStatus(board), tone: halted ? "alert" : "normal" },
    { value: nudgeEnabled(nudge) ? "nudge on" : "nudge off", tone: "normal" },
  ]

  if (halted) {
    // Both the status and the count are red: "3/3" next to a normal-coloured
    // row is easy to miss, and it is the part that explains why it stopped.
    labels.push({ value: `${attempts}/${budget} ${budget === 1 ? "try" : "tries"}`, tone: exhausted ? "alert" : "normal" })
  } else if (attempts > 0) {
    labels.push({ value: `${attempts}/${budget} ${budget === 1 ? "try" : "tries"}`, tone: "normal" })
  } else {
    labels.push({ value: `${budget} ${budget === 1 ? "try" : "tries"}`, tone: "normal" })
  }

  if (nudge?.paused) labels.push({ value: "paused", tone: "normal" })

  const cells: StatusCell[] = []
  for (const [index, label] of labels.entries()) {
    if (index > 0) cells.push({ kind: "dot" })
    cells.push({ kind: "text", value: label.value, tone: label.tone })
  }
  return cells
}

/**
 * Shown only in dialogs, when a picker has nothing to pick from.
 *
 * Deliberately absent from the panel: an empty list under a `(0/0)` heading is
 * self-evident, and a "no tasks yet" line there is just noise between the
 * heading and whatever the user actually wants to read.
 */
export const EMPTY_BOARD = "There are no tasks on this board yet."

/** One-line status for a dialog row: `✓ 3 · Fix the compiler`. */
export function itemLabel(item: Item): string {
  return `${statusGlyph(item.status)} ${item.id} · ${item.title}`
}

/**
 * One line of the board, as the agent sees it.
 *
 * A container gets a checkbox rather than the `·` a plain pending task gets,
 * because "pending" is not a state a container can be in — it has no work of its
 * own. `[x]` only when every level beneath it is done, recursively, which is
 * what makes the box mean "this whole branch is finished" instead of "its
 * direct children are".
 */
export function rowLabel(item: Item, board: Board): string {
  const glyph = isFolder(board, item.id)
    ? containerDone(board, item.id)
      ? "[x]"
      : "[ ]"
    : statusGlyph(item.status)
  return `${glyph} ${item.id} · ${item.title}`
}

/** Shorten to `max` columns, with an ellipsis when it had to cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  if (max === 1) return "…"
  return `${text.slice(0, max - 1)}…`
}

/** Wrap the text a nudge should announce: `k3 · Fix the compiler`. */
export function nudgeLabelFor(item: Item): string {
  return `${item.id} · ${truncate(item.title, 60)}`
}

/** `2/5 done` — the panel's progress counter. */
export function progressLabel(board: Board): string {
  const { done, total } = progress(board)
  return `${done}/${total} done`
}

/** The nudge state, ready to show. */
export function nudgeStatusLabel(nudge: NudgeState, maxAttempts?: number): string {
  return nudgeLabel(nudge, maxAttempts)
}

/** Full text for `kanban_read`, so the agent gets everything in one call. */
export function renderBoard(board: Board, maxAttempts?: number): string {
  const lines: string[] = []
  lines.push(`# ${board.name}`)
  lines.push(`session: ${board.sessionID}`)
  lines.push(`progress: ${progressLabel(board)}`)
  lines.push(`nudge: ${nudgeStatusLabel(board.nudge, maxAttempts)}${board.nudge.lastResult ? ` (${board.nudge.lastResult})` : ""}`)

  if (board.items.length === 0) {
    lines.push("")
    lines.push("Board is empty. Add work with kanban_write.")
    return lines.join("\n")
  }

  lines.push("")
  // Depth-first with an indent per level. Flat was actively misleading: an
  // agent reading this cannot tell a folder from a leaf, and would try to tick
  // a container that only closes when its subtasks do.
  for (const { item, depth } of treeRows(board)) {
    const indent = "  ".repeat(depth)
    const marker = item.id === board.currentID ? " (current)" : ""
    lines.push(`${indent}${rowLabel(item, board)}${marker}`)
    if (item.detail) {
      lines.push(`${indent}    detail: ${item.detail.replace(/\n/g, "\n    ")}`)
    }
  }

  // `nextItem`, not a second opinion written here. This line used to have its own
  // `find`, which meant the panel's marker and the nudge agreed while this
  // pointer disagreed with both — and it was the copy that pointed at folders.
  const next = nextItem(board)
  if (next) {
    lines.push("")
    lines.push(`Next up if you need a pointer: ${next.id} · ${next.title}`)
  }
  return lines.join("\n")
}

/** Toast text for a nudge, so the human always sees the counter move. */
export function nudgeToast(item: Item, attempt: number, maxAttempts: number, willHalt: boolean): string {
  const tail = willHalt ? ` — last try, then I stop` : ` — ${maxAttempts - attempt} left`
  return `nudge ${attempt}/${maxAttempts}: ${item.id} · ${truncate(item.title, 40)}${tail}`
}