/**
 * Persistence: one JSON file per worktree, holding every session's board.
 *
 * This stands in for plugin storage, which does not exist in the plugin API
 * (`PluginInput` has no storage handle, and `api.kv` is TUI-local and far too
 * small for a work list). A file in the worktree is durable across restarts,
 * survives compaction, and can be inspected by the human with `cat`.
 *
 * Two processes may write it — the server plugin (agent tools) and the TUI
 * plugin (dialogs) — so writes are atomic: a temp file plus a rename, which is
 * a single filesystem operation. A reader therefore never sees a half-written
 * file, which is exactly the failure that used to truncate state.
 *
 * A corrupt file is quarantined, never silently overwritten. Losing a board to
 * a bug is bad; losing a board to a bug *and* destroying the evidence is worse.
 */

import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { type Board, freshBoard } from "./types.ts"
import { normalizeBoard } from "./board.ts"

export const STATE_DIR = ".opencode"
export const STATE_FILE = "kanban.json"

/** `<worktree>/.opencode` — where the board lives. */
export function stateDir(worktree: string): string {
  return path.join(worktree, STATE_DIR)
}

/** `<worktree>/.opencode/kanban.json` */
export function statePath(worktree: string): string {
  return path.join(stateDir(worktree), STATE_FILE)
}

type StateFile = {
  version: 1
  /** Boards keyed by session id. */
  boards: Record<string, unknown>
}

/**
 * Read one session's board, repairing whatever is missing. A missing or
 * unreadable file is not an error — a fresh board is the right answer, and the
 * human has not lost anything that was ever there.
 */
export async function load(worktree: string, sessionID: string): Promise<Board> {
  let raw: string
  try {
    raw = await readFile(statePath(worktree), "utf8")
  } catch {
    return freshBoard(sessionID)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await quarantine(worktree)
    return freshBoard(sessionID)
  }

  const boards = (parsed as Partial<StateFile> | null)?.boards
  if (typeof boards !== "object" || boards === null) {
    await quarantine(worktree)
    return freshBoard(sessionID)
  }

  return normalizeBoard(boards[sessionID], sessionID)
}

/** Write one session's board, leaving other sessions untouched. */
export async function save(worktree: string, board: Board): Promise<void> {
  const dir = stateDir(worktree)
  await mkdir(dir, { recursive: true })

  const target = statePath(worktree)
  let boards: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<StateFile> | null
    if (typeof parsed?.boards === "object" && parsed.boards !== null) {
      boards = { ...parsed.boards }
    }
  } catch {
    // Missing or unreadable: start a fresh map. save() overwrites anyway, and
    // load() is what quarantines so a human can still recover a corrupt file.
  }

  boards[board.sessionID] = board
  const payload: StateFile = { version: 1, boards }
  const serialised = `${JSON.stringify(payload, null, 2)}\n`

  // Atomic replace. The temp file sits in the same directory so the rename
  // cannot cross a filesystem boundary and degrade into copy-then-delete.
  const temp = path.join(dir, `${STATE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  await writeFile(temp, serialised, "utf8")
  try {
    await rename(temp, target)
  } catch (error) {
    await writeFile(target, serialised, "utf8").catch(() => {})
    await import("node:fs/promises").then((fs) => fs.unlink(temp).catch(() => {}))
    throw error
  }
}

/** Move a corrupt file aside so it can be inspected, and start clean. */
async function quarantine(worktree: string): Promise<void> {
  const target = statePath(worktree)
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`
  try {
    await rename(target, `${target}.corrupt-${stamp}`)
  } catch {
    // Nothing to quarantine (already gone, or never existed).
  }
}

/** Drop one session's board. Used when its session is deleted. */
export async function forget(worktree: string, sessionID: string): Promise<void> {
  let boards: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(statePath(worktree), "utf8")) as Partial<StateFile> | null
    if (typeof parsed?.boards === "object" && parsed.boards !== null) boards = { ...parsed.boards }
  } catch {
    return
  }
  if (!(sessionID in boards)) return
  delete boards[sessionID]
  const payload: StateFile = { version: 1, boards }
  const serialised = `${JSON.stringify(payload, null, 2)}\n`
  await mkdir(stateDir(worktree), { recursive: true })
  const temp = path.join(stateDir(worktree), `${STATE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  await writeFile(temp, serialised, "utf8")
  await rename(temp, statePath(worktree))
}