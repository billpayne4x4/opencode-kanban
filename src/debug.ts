/**
 * Debug logging.
 *
 * When it is on, everything the plugin does gets a timestamped line in one file
 * you can `tail -f`. The point is to answer the questions that have been
 * unanswerable in this session: did the idle event arrive, was the nudge
 * suppressed or never attempted, which slash command ran, and did the panel
 * reload.
 *
 * Writes are synchronous and best-effort. A debug log must never be the reason
 * a tool call fails, so every error here is swallowed.
 */

import { appendFileSync } from "node:fs"
import type { Board } from "./types.ts"

/**
 * Where the log is written.
 *
 * Overridable so the test suite cannot scribble on the real log — it writes ~20
 * lines per run, which buries the one thing you open this file to see.
 */
export const DEBUG_LOG = process.env.KANBAN_DEBUG_LOG ?? "/tmp/opencode-kanban-debug.log"

/** Is debug logging switched on for this board? Absent means off. */
export function debugOn(board: { debug?: boolean } | undefined): boolean {
  return board?.debug === true
}

/** Categories, so the log is greppable rather than a wall of prose. */
export type DebugCategory = "tool" | "event" | "nudge" | "command" | "state" | "error"

/**
 * Append one line, if debug is on for this board.
 *
 * Returns whether it wrote, so callers can also use it as a trace point without
 * a second lookup.
 */
export function debug(board: { debug?: boolean } | undefined, category: DebugCategory, message: string): boolean {
  if (!debugOn(board)) return false
  write(who(board), category, message)
  return true
}

/**
 * Which window a line came from.
 *
 * Two projects run this plugin at once, and they share one log file. Without a
 * tag on every line there is no way to tell which window was nudged, which
 * halted, and which stayed quiet — so a single ambiguous line reads as a
 * mystery when it is really two unrelated sessions interleaved.
 *
 * Short on purpose: project name plus the session's last four characters is
 * enough to match a line against a window title, and long enough not to wrap.
 */
function who(board: { debug?: boolean; project?: string; sessionID?: string } | undefined): string {
  const project = board?.project ?? "?"
  const session = board?.sessionID ? board.sessionID.slice(-4) : "????"
  return `${project}#${session}`
}

function write(tag: string, category: DebugCategory, message: string): void {
  const line = `${new Date().toISOString()} ${tag} [${category}] ${message.replace(/\s+/g, " ").trim()}\n`
  try {
    appendFileSync(DEBUG_LOG, line)
  } catch {
    // A full disk or a read-only /tmp must not break the thing being debugged.
  }
}

/**
 * Log an unconditional line, ignoring the on/off flag.
 *
 * For lifecycle facts that are useful once and then noise forever: the plugin
 * attaching, and the file it will write to.
 */
export function debugAlways(category: DebugCategory, message: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${category}] ${message.replace(/\s+/g, " ").trim()}\n`)
  } catch {
    // Same reasoning as above.
  }
}

/** The panel's one-line summary, shown only while debug is on. */
export const DEBUG_PANEL_LABEL = `debug · ${DEBUG_LOG}`