/**
 * Presentation helpers. Pure so the panel can be checked without a terminal.
 *
 * Colours are picked from the host theme by name (see `statusColor`); nothing
 * here hardcodes a colour so the plugin inherits whatever theme is active.
 */

import { type Board, type Item, type ItemStatus, type NudgeState } from "./types.ts"
import { progress } from "./board.ts"
import { nudgeLabel } from "./nudge.ts"

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
 * A rule under the heading, sized to the heading.
 *
 * OpenTUI has no divider element, so this is text. Matching the heading width
 * looks deliberate where a fixed 40 columns looks broken in a narrow sidebar.
 */
export function panelRule(title: string): string {
  return "─".repeat(Math.max(1, title.length))
}

/** The empty-board line. The heading still shows `(0/0)` above it. */
export const EMPTY_BOARD = "no tasks yet — /kanban-add or ask the agent"

/** One-line status for a dialog row: `✓ 3 · Fix the compiler`. */
export function itemLabel(item: Item): string {
  return `${statusGlyph(item.status)} ${item.id} · ${item.title}`
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
  for (const item of board.items) {
    const marker = item.id === board.currentID ? " (current)" : ""
    lines.push(`${itemLabel(item)}${marker}`)
    if (item.detail) {
      lines.push(`    detail: ${item.detail.replace(/\n/g, "\n    ")}`)
    }
  }

  const next = board.items.find((item) => item.id !== board.currentID && item.status !== "done")
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