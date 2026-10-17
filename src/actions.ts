/**
 * Every board mutation, in one place.
 *
 * The agent's `kanban_write` tool and the TUI dialogs are two front doors onto
 * the same board, so they share this module rather than each calling the
 * reducers directly. Two reasons that matters:
 *
 * - Validation happens once. A `BoardError` raised here is reported the same
 *   way whether it came from a model or a keystroke.
 * - The progress rule runs on every write. An item reaching `done` resets the
 *   nudge counter, and there is exactly one code path where that can happen.
 */

import { type Board, type ItemStatus, freshBoard } from "./types.ts"
import {
  BoardError,
  addItem,
  clearBoard,
  removeItem,
  reorder,
  setCurrent,
  updateItem,
} from "./board.ts"
import { noteProgress, pause, resume, unpause, withProgressPolicy } from "./nudge.ts"
import { type NudgeState } from "./types.ts"

/** One board operation. */
export type Mutation =
  | { op: "add"; title: string; detail?: string; status?: ItemStatus }
  | { op: "update"; id: string; title?: string; detail?: string; status?: ItemStatus }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; to: number }
  | { op: "current"; id?: string }
  | { op: "clear" }
  | { op: "pause" }
  | { op: "resume" }
  | { op: "unpause" }
  | { op: "composer"; busy: boolean }

export type Store = {
  read(sessionID: string): Promise<Board>
  write(board: Board): Promise<void>
}

export type ApplyResult = {
  board: Board
  /** Human-readable confirmation. */
  message: string
}

const OP_NAMES: Record<Mutation["op"], string> = {
  add: "add",
  update: "update",
  remove: "remove",
  move: "move",
  current: "set-current",
  clear: "clear",
  pause: "pause",
  resume: "resume",
  unpause: "unpause",
  composer: "composer",
}

/** Narrow an unknown value from a tool call into a `Mutation`. */
export function parseMutation(input: unknown): Mutation {
  if (typeof input !== "object" || input === null) throw new BoardError("mutation must be an object")
  const raw = input as Record<string, unknown>
  const op = raw.op
  if (typeof op !== "string" || !(op in OP_NAMES)) {
    throw new BoardError(`op must be one of: ${Object.values(OP_NAMES).join(", ")}`)
  }
  switch (op) {
    case "add":
      if (typeof raw.title !== "string") throw new BoardError("add needs a title")
      return { op: "add", title: raw.title, detail: asOptionalString(raw.detail), status: asStatus(raw.status) }
    case "update":
      if (typeof raw.id !== "string") throw new BoardError("update needs an id")
      return {
        op: "update",
        id: raw.id,
        title: asOptionalString(raw.title),
        detail: asOptionalString(raw.detail),
        status: asStatus(raw.status),
      }
    case "remove":
      if (typeof raw.id !== "string") throw new BoardError("remove needs an id")
      return { op: "remove", id: raw.id }
    case "move":
      if (typeof raw.id !== "string") throw new BoardError("move needs an id")
      if (typeof raw.to !== "number") throw new BoardError("move needs a numeric `to` index")
      return { op: "move", id: raw.id, to: raw.to }
    case "current":
      return { op: "current", id: asOptionalString(raw.id) }
    case "composer":
      return { op: "composer", busy: raw.busy === true }
    default:
      return { op: op as "clear" | "pause" | "resume" | "unpause" }
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new BoardError("expected a string")
  return value
}

function asStatus(value: unknown): ItemStatus | undefined {
  if (value === undefined || value === null) return undefined
  if (value !== "pending" && value !== "in_progress" && value !== "done" && value !== "blocked") {
    throw new BoardError(`status must be pending, in_progress, done or blocked`)
  }
  return value
}

function nudgeOp(board: Board, next: NudgeState): Board {
  return { ...board, nudge: next }
}

/**
 * Apply one mutation: read, reduce, apply the progress rule, persist.
 * Throws `BoardError` with a message fit to show a user.
 */
export async function apply(store: Store, sessionID: string, mutation: Mutation, now = Date.now()): Promise<ApplyResult> {
  const before = await store.read(sessionID)
  const board = before ?? freshBoard(sessionID)

  let next: Board
  let message: string

  switch (mutation.op) {
    case "add": {
      const result = addItem(board, mutation, now)
      next = result.board
      message = `added ${result.item.id}: ${result.item.title}`
      break
    }
    case "update": {
      next = updateItem(board, mutation.id, mutation, now)
      message = `updated ${mutation.id}`
      break
    }
    case "remove":
      next = removeItem(board, mutation.id, now)
      message = `removed ${mutation.id}`
      break
    case "move":
      next = reorder(board, mutation.id, mutation.to, now)
      message = `moved ${mutation.id} to position ${mutation.to}`
      break
    case "current":
      next = setCurrent(board, mutation.id, now)
      message = mutation.id ? `current is now ${mutation.id}` : "current cleared"
      break
    case "clear": {
      const removed = board.items.length
      next = clearBoard(board, now)
      message = `cleared ${removed} item(s)`
      break
    }
    case "pause":
      next = nudgeOp(board, pause(board.nudge))
      message = "nudging paused"
      break
    case "unpause":
      next = nudgeOp(board, unpause(board.nudge))
      message = "nudging resumed (counter kept)"
      break
    case "resume":
      next = nudgeOp(board, resume(board.nudge))
      message = "nudging resumed, counter reset"
      break
    case "composer":
      next = { ...board, composerBusy: mutation.busy, updatedAt: now }
      message = mutation.busy ? "composer marked busy" : "composer marked free"
      break
    default: {
      const exhaustive: never = mutation
      throw new BoardError(`unsupported op ${JSON.stringify(exhaustive)}`)
    }
  }

  const final = { ...withProgressPolicy(board, next), updatedAt: now }
  await store.write(final)
  return { board: final, message }
}

/** Reset the counter when an item completes — exposed for the write tool. */
export function onItemCompleted(board: Board): Board {
  return { ...board, nudge: noteProgress(board.nudge) }
}