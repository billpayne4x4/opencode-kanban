/**
 * The board reducer: pure functions from a board to a board.
 *
 * Nothing here touches the filesystem, the clock, or the network, so every
 * rule below is directly testable. That matters more than usual here because
 * these functions are the only thing standing between a half-written board and
 * a lost work list.
 *
 * Every mutator returns a new board. Nothing is edited in place, which makes
 * "did this change actually do anything?" a cheap question in tests.
 */

import { type Board, type Item, type ItemStatus, freshBoard, freshNudge } from "./types.ts"

const VALID_STATUSES: readonly ItemStatus[] = ["pending", "in_progress", "done", "blocked"]

export class BoardError extends Error {}

function touch(board: Board, now: number): Board {
  return { ...board, updatedAt: now }
}

/**
 * Next short id for this board: `k1`, `k2`, ... Reuses the highest existing
 * number rather than the length, so deleting an item never collides.
 */
export function nextID(board: Board): string {
  let max = 0
  for (const item of board.items) {
    const match = /^k(\d+)$/.exec(item.id)
    if (!match) continue
    const value = Number(match[1])
    if (value > max) max = value
  }
  return `k${max + 1}`
}

function clampText(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string") throw new BoardError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > limit) throw new BoardError(`${field} must be at most ${limit} characters`)
  return trimmed
}

function requireItem(board: Board, id: string): Item {
  const item = board.items.find((candidate) => candidate.id === id)
  if (!item) throw new BoardError(`no item ${id} on this board`)
  return item
}

/**
 * Append an item. Status defaults to `pending`; exactly one item may be
 * `in_progress`, so adding an in-progress item promotes it and demotes
 * whatever was current.
 */
export function addItem(
  board: Board,
  input: { title: string; detail?: string; status?: ItemStatus },
  now = Date.now(),
): { board: Board; item: Item } {
  const title = clampText(input.title, 200, "title")
  if (!title) throw new BoardError("title must not be empty")
  const detail = input.detail === undefined ? undefined : clampText(input.detail, 8000, "detail")
  const status = input.status ?? "pending"
  if (!VALID_STATUSES.includes(status)) throw new BoardError(`unknown status ${status}`)

  const item: Item = {
    id: nextID(board),
    title,
    detail: detail || undefined,
    status,
    createdAt: now,
    updatedAt: now,
  }

  const others = board.items.map((existing) =>
    status === "in_progress" && existing.status === "in_progress"
      ? { ...existing, status: "pending" as ItemStatus, updatedAt: now }
      : existing,
  )

  return {
    board: {
      ...touch({ ...board, items: [...others, item] }, now),
      currentID: status === "in_progress" ? item.id : board.currentID,
    },
    item,
  }
}

/** Patch an item's fields. Only the keys present in `patch` are touched. */
export function updateItem(
  board: Board,
  id: string,
  patch: { title?: string; detail?: string; status?: ItemStatus },
  now = Date.now(),
): Board {
  const existing = requireItem(board, id)
  if (patch.title === undefined && patch.detail === undefined && patch.status === undefined) {
    throw new BoardError("update needs at least one of title, detail, status")
  }
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status)) {
    throw new BoardError(`unknown status ${patch.status}`)
  }
  const title = patch.title === undefined ? existing.title : clampText(patch.title, 200, "title")
  if (!title) throw new BoardError("title must not be empty")
  const detail =
    patch.detail === undefined ? existing.detail : patch.detail === null ? undefined : clampText(patch.detail, 8000, "detail")

  const nextStatus = patch.status ?? existing.status
  const items = board.items.map((item) => {
    if (item.id !== id) {
      // Only one item is ever in_progress; promoting one demotes the rest.
      if (nextStatus === "in_progress" && item.status === "in_progress") {
        return { ...item, status: "pending" as ItemStatus, updatedAt: now }
      }
      return item
    }
    return { ...item, title, detail: detail || undefined, status: nextStatus, updatedAt: now }
  })

  let currentID = board.currentID
  if (nextStatus === "in_progress") currentID = id
  else if (nextStatus === "done" && currentID === id) {
    // Finishing the current item hands the baton to whatever is next.
    const successor = items.find((item) => item.status === "pending")
    currentID = successor?.id
  }

  return touch({ ...board, items, currentID }, now)
}

/** Remove an item. Removing the current item advances to the next open one. */
export function removeItem(board: Board, id: string, now = Date.now()): Board {
  requireItem(board, id)
  const items = board.items.filter((item) => item.id !== id)
  const currentID = board.currentID === id ? items.find((item) => item.status === "pending")?.id : board.currentID
  return touch({ ...board, items, currentID }, now)
}

/** Move `id` to index `toIndex`, clamped into range. */
export function reorder(board: Board, id: string, toIndex: number, now = Date.now()): Board {
  requireItem(board, id)
  const from = board.items.findIndex((item) => item.id === id)
  const items = [...board.items]
  const [moved] = items.splice(from, 1)
  const target = Math.max(0, Math.min(Math.trunc(toIndex), items.length))
  items.splice(target, 0, moved)
  return touch({ ...board, items }, now)
}

/** Point `currentID` at an item. Pass `undefined` to clear it. */
export function setCurrent(board: Board, id: string | undefined, now = Date.now()): Board {
  if (id !== undefined) requireItem(board, id)
  return touch({ ...board, currentID: id }, now)
}

/** Drop every item, keep the nudge policy and the board identity. */
export function clearBoard(board: Board, now = Date.now()): Board {
  return touch({ ...board, items: [], currentID: undefined }, now)
}

/**
 * Progress counters for the panel header.
 *
 * Takes anything with an `items` list, not a whole `Board`, so callers holding
 * a partial view (the panel, before a board has loaded) can still count rather
 * than having to fabricate an empty board.
 */
export function progress(view: { items: readonly Item[] }): { done: number; total: number } {
  const done = view.items.filter((item) => item.status === "done").length
  return { done, total: view.items.length }
}

/** Items that are not done, in board order. */
export function openItems(board: Board): Item[] {
  return board.items.filter((item) => item.status !== "done")
}

/** The board has unfinished work. An empty board is finished. */
export function hasOpenWork(board: Board): boolean {
  return board.items.some((item) => item.status !== "done")
}

/**
 * The item a nudge should point at: the explicit `currentID` if it is still
 * open, otherwise the in-progress item, otherwise the first pending one.
 * Returns undefined when there is nothing to do — the caller must not nudge.
 */
export function nextItem(board: Board): Item | undefined {
  if (board.currentID) {
    const current = board.items.find((item) => item.id === board.currentID)
    if (current && current.status !== "done") return current
  }
  return board.items.find((item) => item.status === "in_progress")
    ?? board.items.find((item) => item.status === "pending")
    ?? board.items.find((item) => item.status === "blocked")
}

/** True when an item reached `done` in `next` that was not done in `prev`. */
export function madeProgress(prev: Board, next: Board): boolean {
  const before = new Map(prev.items.map((item) => [item.id, item.status]))
  return next.items.some((item) => before.get(item.id) !== "done" && item.status === "done")
}

/** Read a board off disk-shaped data, repairing anything missing. */
export function normalizeBoard(raw: unknown, sessionID: string): Board {
  if (typeof raw !== "object" || raw === null) return freshBoard(sessionID)
  const source = raw as Partial<Board>
  const nudge = { ...freshNudge(), ...(source.nudge ?? {}) }
  const items: Item[] = Array.isArray(source.items)
    ? source.items.flatMap((item) => {
        if (typeof item !== "object" || item === null) return []
        const candidate = item as Partial<Item>
        if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return []
        const status = VALID_STATUSES.includes(candidate.status as ItemStatus)
          ? (candidate.status as ItemStatus)
          : "pending"
        const now = Date.now()
        return [{
          id: candidate.id,
          title: candidate.title,
          detail: typeof candidate.detail === "string" ? candidate.detail : undefined,
          status,
          createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
          updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now,
        }]
      })
    : []
  const ids = new Set(items.map((item) => item.id))
  return {
    sessionID,
    name: typeof source.name === "string" ? source.name : "Board",
    items,
    currentID: typeof source.currentID === "string" && ids.has(source.currentID) ? source.currentID : undefined,
    nudge,
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : Date.now(),
    composerBusy: source.composerBusy === true,
  }
}