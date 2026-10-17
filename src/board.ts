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

/** Direct children of a folder. */
export function childrenOf(board: Board, id: string): Item[] {
  return board.items.filter((item) => item.parentID === id)
}

/** True when this item contains anything. Containers are never ticked by hand. */
export function isFolder(board: Board, id: string): boolean {
  return childrenOf(board, id).length > 0
}

/**
 * How much of a container is done, counting every level beneath it.
 *
 * Recursive on purpose: a folder whose subtasks each have their own is complete
 * when every leaf under it is done, not when its direct children are. Counting
 * one level is how a group reports itself finished while work is still open two
 * levels down — and it is the mistake this readout would hand straight to the
 * auto-close rule if it were the only test of completeness.
 *
 * Read from the descendants rather than from the container's own status, so a
 * board written before a rule changed still reports the truth.
 */
export function descendantProgress(board: Board, id: string): { done: number; total: number } {
  // Leaves only. Counting containers makes the number depend on the order two
  // rules happen to run in: a container's own status is derived by
  // `closeCompletedAncestors`, so before that runs it is still `pending` even
  // though every leaf under it is done, and the panel would report 2/3 for a
  // branch that is finished. A leaf is a real unit of work; a container is not.
  const leaves = descendantsOf(board, id).filter((item) => !isFolder(board, item.id))
  return { done: leaves.filter((item) => item.status === "done").length, total: leaves.length }
}

/** A container is complete when it has work beneath it and all of it is done. */
export function containerDone(board: Board, id: string): boolean {
  const { done, total } = descendantProgress(board, id)
  return total > 0 && done === total
}

/**
 * Every descendant of a folder, depth first.
 *
 * `seen` is what stops a loop hanging the process: `parentID` arrives from a
 * JSON file, so a hand-edited board can contain a cycle, and the recursive walk
 * would never come back from one.
 */
export function descendantsOf(board: Board, id: string, seen = new Set<string>()): Item[] {
  const out: Item[] = []
  for (const child of childrenOf(board, id)) {
    if (seen.has(child.id)) continue
    seen.add(child.id)
    out.push(child, ...descendantsOf(board, child.id, seen))
  }
  return out
}

/** One line of a drawn board: the item, and how deep in the tree it sits. */
export type Row = { item: Item; depth: number }

/**
 * Every item in the order a person reads it: each parent immediately followed by
 * its own subtree, siblings in the order they were added.
 *
 * `board.items` is creation order — right for storage, useless for reading. A
 * child added after its parent lands beside unrelated siblings, so a four-level
 * tree draws as one flat list and the nesting becomes invisible. Everything that
 * renders a board goes through this instead of indexing `items` directly.
 *
 * Two damaged-board cases are handled rather than assumed away, because a board
 * file is editable text:
 *
 * - a `parentID` naming a missing item becomes a root, so the item still shows;
 * - a cycle is broken where it repeats, and anything it made unreachable is
 *   still listed at the left margin — a visible oddity beats a lost task.
 */
export function treeRows(board: Board): Row[] {
  const ids = new Set(board.items.map((item) => item.id))
  const kids = new Map<string, Item[]>()
  const roots: Item[] = []
  for (const item of board.items) {
    if (item.parentID && ids.has(item.parentID)) {
      const siblings = kids.get(item.parentID) ?? []
      siblings.push(item)
      kids.set(item.parentID, siblings)
    } else {
      roots.push(item)
    }
  }

  const rows: Row[] = []
  const seen = new Set<string>()
  const walk = (item: Item, depth: number) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    rows.push({ item, depth })
    for (const child of kids.get(item.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  for (const item of board.items) if (!seen.has(item.id)) walk(item, 0)
  return rows
}

/**
 * Close every ancestor that has run out of open work.
 *
 * A folder's status is derived, never set by hand, so this is the only thing
 * that can close one. Walking up after each completion keeps the tree honest
 * without anyone having to tick the parents.
 */
export function closeCompletedAncestors(board: Board, now = Date.now()): Board {
  let next = board
  for (const item of board.items) {
    let parent = item.parentID
    while (parent) {
      const container = next.items.find((entry) => entry.id === parent)
      if (!container) break
      const stillOpen = descendantsOf(next, parent).some((entry) => entry.status !== "done")
      if (!stillOpen && container.status !== "done") {
        next = { ...next, items: next.items.map((entry) => (entry.id === parent ? { ...entry, status: "done" as ItemStatus, updatedAt: now } : entry)) }
      }
      parent = container.parentID
    }
  }
  return next
}

/**
 * Would nesting `child` under `parent` create a loop?
 *
 * The question is whether `parent` already sits inside `child`'s own subtree —
 * that is the only way a cycle appears. Asking it the other way round (is the
 * child already under the parent) would be true for every legitimate re-file
 * and miss the real loop entirely.
 */
export function wouldCycle(board: Board, child: string, parent: string): boolean {
  return child === parent || descendantsOf(board, child).some((item) => item.id === parent)
}

/**
 * Every container above an item, nearest first.
 *
 * Used to tint the folder holding the task you are on, so "where am I" is
 * answered by colour without colouring every folder on the board.
 */
export function ancestorIds(board: Board, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let item = board.items.find((entry) => entry.id === id)
  while (item?.parentID) {
    // A loop in a hand-edited file must not spin here forever.
    if (seen.has(item.parentID)) break
    seen.add(item.parentID)
    out.push(item.parentID)
    item = board.items.find((entry) => entry.id === item!.parentID)
  }
  return out
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
  input: { title: string; detail?: string; status?: ItemStatus; parentID?: string },
  now = Date.now(),
): { board: Board; item: Item } {
  const title = clampText(input.title, 200, "title")
  if (!title) throw new BoardError("title must not be empty")
  const detail = input.detail === undefined ? undefined : clampText(input.detail, 8000, "detail")
  const status = input.status ?? "pending"
  if (!VALID_STATUSES.includes(status)) throw new BoardError(`unknown status ${status}`)

  if (input.parentID !== undefined) {
    requireItem(board, input.parentID)
    if (wouldCycle(board, nextID(board), input.parentID)) throw new BoardError("that parent would nest inside itself")
  }

  const item: Item = {
    id: nextID(board),
    title,
    detail: detail || undefined,
    status,
    parentID: input.parentID,
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
  patch: { title?: string; detail?: string; status?: ItemStatus; parentID?: string },
  now = Date.now(),
): Board {
  const existing = requireItem(board, id)
  if (patch.status !== undefined && patch.status === "done" && childrenOf(board, id).length > 0) {
    throw new BoardError(`${id} is a folder — it closes when its subtasks close`)
  }
  if (patch.parentID !== undefined) {
    if (patch.parentID) {
      requireItem(board, patch.parentID)
      if (wouldCycle(board, id, patch.parentID)) throw new BoardError("that would nest a folder inside itself")
    }
  }
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
    // Only touch parentID when the patch actually mentions it; assigning the
    // undefined default silently unfiled the item on any unrelated edit.
    return {
      ...item,
      title,
      detail: detail || undefined,
      status: nextStatus,
      ...(patch.parentID !== undefined ? { parentID: patch.parentID || undefined } : {}),
      updatedAt: now,
    }
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
 * The first open *task* inside a container, depth first.
 *
 * "Task" means not a container. A folder is a shape, not a unit of work: it
 * cannot be ticked by hand and it cannot be finished, so pointing a marker or a
 * nudge at one asks for something the agent cannot deliver.
 */
function firstOpenTask(board: Board, id: string): Item | undefined {
  for (const child of childrenOf(board, id)) {
    if (child.status === "done") continue
    if (!isFolder(board, child.id)) return child
    const deeper = firstOpenTask(board, child.id)
    if (deeper) return deeper
  }
  return undefined
}

/**
 * The item a nudge — and the panel's marker — should point at: the explicit
 * `currentID` if it is still open, otherwise the in-progress item, otherwise the
 * first pending one. Returns undefined when there is nothing to do — the caller
 * must not nudge.
 *
 * Whatever that lands on, a container descends to its first open task. The
 * alternative was worse than cosmetic: the marker sat on a folder, the folder
 * could not be marked done, and the agent was told to go and finish something
 * that had no finish to it.
 */
export function nextItem(board: Board): Item | undefined {
  const settle = (item: Item | undefined): Item | undefined => {
    if (!item) return undefined
    return isFolder(board, item.id) ? (firstOpenTask(board, item.id) ?? item) : item
  }
  if (board.currentID) {
    const current = board.items.find((item) => item.id === board.currentID)
    if (current && current.status !== "done") return settle(current)
  }
  return settle(
    board.items.find((item) => item.status === "in_progress")
      ?? board.items.find((item) => item.status === "pending")
      ?? board.items.find((item) => item.status === "blocked"),
  )
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
          // Dropping this silently flattens the whole tree on every read.
          parentID: typeof candidate.parentID === "string" ? candidate.parentID : undefined,
          status,
          createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
          updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now,
        }]
      })
    : []
  const ids = new Set(items.map((item) => item.id))
  for (const item of items) {
    if (item.parentID && !ids.has(item.parentID)) delete item.parentID
  }
  return {
    sessionID,
    name: typeof source.name === "string" ? source.name : "Board",
    items,
    currentID: typeof source.currentID === "string" && ids.has(source.currentID) ? source.currentID : undefined,
    nudge,
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : Date.now(),
    composerBusy: source.composerBusy === true,
    debug: source.debug === true,
  }
}