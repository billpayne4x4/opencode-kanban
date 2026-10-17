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
  closeCompletedAncestors,
  clearBoard,
  removeItem,
  reorder,
  setCurrent,
  updateItem,
  wouldCycle,
} from "./board.ts"
import { noteProgress, pause, resume, unpause, withProgressPolicy } from "./nudge.ts"
import { DEBUG_LOG } from "./debug.ts"
import path from "node:path"
import { TASKS_DIR, TASKS_FILE, TEMPLATE_FILE, TEMPLATE, parseTasks, renderTasks, type ParsedNode } from "./markdown.ts"
import { type NudgeState } from "./types.ts"

/** One board operation. */
export type Mutation =
  | { op: "add"; title: string; detail?: string; status?: ItemStatus }
  /**
   * Add many at once. Preferred over repeated `add` calls: one round trip
   * instead of N, and the whole batch is validated before anything is written
   * so a bad entry cannot leave a half-built plan.
   */
  | { op: "addMany"; items: { title: string; detail?: string; status?: ItemStatus }[] }
  | { op: "update"; id: string; title?: string; detail?: string; status?: ItemStatus }
  | { op: "remove"; id: string }
  /**
   * Remove many at once. The counterpart to `addMany`: trimming a plan is as
   * common as writing one, and 69 individual calls is 69 round trips.
   */
  | { op: "removeMany"; ids: string[] }
  /**
   * Move many tasks to one position, keeping the order given. `to` is an
   * index (0 = the very top); `to: -1` means the end, because "put these at the
   * front" is how people actually think about reordering.
   */
  | { op: "moveMany"; ids: string[]; to: number }
  /** Change the same fields on many tasks at once — "mark these all blocked". */
  | { op: "updateMany"; ids: string[]; title?: string; detail?: string; status?: ItemStatus }
  | { op: "move"; id: string; to: number }
  /** A container, not a unit of work: it closes when its subtasks close. */
  | { op: "folder"; title: string; detail?: string }
  /** One subtask under a folder. */
  | { op: "subtask"; parentID: string; title: string; detail?: string }
  /** Many subtasks under one folder, in a single call. */
  | { op: "subtasks"; parentID: string; items: { title: string; detail?: string }[] }
  /** Re-file a task under a different folder, or to the top with `parentID: ""`. */
  | { op: "reparent"; id: string; parentID: string }
  | { op: "current"; id?: string }
  | { op: "clear" }
  | { op: "pause" }
  | { op: "resume" }
  | { op: "unpause" }
  /** Switch the whole restart policy on or off. */
  | { op: "nudge"; enabled: boolean }
  /** Switch the debug log on or off. */
  | { op: "debug"; enabled: boolean }
  /** Set how many nudges happen before halting. */
  | { op: "count"; maxAttempts: number }
  /**
   * Write the board to `.ai/tasks.md` — a checklist a person can read, commit
   * and hand over. The backup nobody can read is not a backup.
   */
  | { op: "export"; path?: string }
  /**
   * Rebuild the board from a checklist file. `content` skips the filesystem
   * entirely, which is what the agent uses when it already has the text.
   */
  | { op: "import"; path?: string; content?: string; merge?: boolean; fromHuman?: boolean }
  /** Write the starter template to `.ai/tasks.template.md`. */
  | { op: "template"; path?: string }
  /**
   * Where notifications appear: a toast, or a coloured block in the window.
   *
   * Persisted on the board rather than in plugin options, because options are
   * read once at load and a person switching this off wants it to stick for the
   * rest of the session without editing a config file.
   */
  | { op: "notify"; mode: NotifyMode }
  | { op: "composer"; busy: boolean }

export type Store = {
  read(sessionID: string): Promise<Board>
  write(board: Board): Promise<void>
  /**
   * Project-root file access, for export and import.
   *
   * Deliberately not part of the board: the board is one JSON file the plugin
   * owns, and giving every mutation a filesystem would make "what can this
   * change?" a much harder question. Only `export`, `import` and `template`
   * ever touch it.
   */
  files?: Files
}

export type Files = {
  /** Read a project file, relative to the root. */
  read(relative: string): Promise<string>
  /** Write a project file, relative to the root. */
  write(relative: string, content: string): Promise<void>
}

export type ApplyResult = {
  board: Board
  /** Human-readable confirmation. */
  message: string
  /** A file this operation wrote, for the notification to name. */
  wrote?: string
}

const OP_NAMES: Record<Mutation["op"], string> = {
  add: "add",
  addMany: "add-many",
  removeMany: "remove-many",
  moveMany: "move-many",
  updateMany: "update-many",
  update: "update",
  remove: "remove",
  move: "move",
  folder: "folder",
  subtask: "subtask",
  subtasks: "subtasks",
  reparent: "reparent",
  current: "set-current",
  clear: "clear",
  pause: "pause",
  resume: "resume",
  unpause: "unpause",
  nudge: "nudge",
  debug: "debug",
  count: "set-count",
  export: "export",
  import: "import",
  template: "template",
  notify: "notify",
  composer: "composer",
}

/** Where a change is announced. */
export type NotifyMode = "toast" | "panel"

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
    case "addMany":
      if (!Array.isArray(raw.items) || raw.items.length === 0) {
        throw new BoardError("addMany needs a non-empty `items` array")
      }
      if (raw.items.length > 500) throw new BoardError("addMany takes at most 500 items")
      return { op: "addMany", items: raw.items.map((entry, index) => parseOne(index, entry)) }
    case "folder":
      if (typeof raw.title !== "string") throw new BoardError("folder needs a title")
      return { op: "folder", title: raw.title, detail: asOptionalString(raw.detail) }
    case "subtask":
      if (typeof raw.parentID !== "string") throw new BoardError("subtask needs a parentID")
      if (typeof raw.title !== "string") throw new BoardError("subtask needs a title")
      return { op: "subtask", parentID: raw.parentID, title: raw.title, detail: asOptionalString(raw.detail) }
    case "subtasks": {
      if (typeof raw.parentID !== "string") throw new BoardError("subtasks needs a parentID")
      if (!Array.isArray(raw.items) || raw.items.length === 0) throw new BoardError("subtasks needs a non-empty `items` array")
      if (raw.items.length > 500) throw new BoardError("subtasks takes at most 500 items")
      return { op: "subtasks", parentID: raw.parentID, items: raw.items.map((entry, index) => parseOne(index, entry)) }
    }
    case "reparent":
      if (typeof raw.id !== "string") throw new BoardError("reparent needs an id")
      if (typeof raw.parentID !== "string") throw new BoardError("reparent needs a parentID (empty string for top level)")
      return { op: "reparent", id: raw.id, parentID: raw.parentID }
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
    case "moveMany": {
      const ids = parseIds(raw.ids)
      if (typeof raw.to !== "number") throw new BoardError("moveMany needs a numeric `to` index (-1 for the end)")
      return { op: "moveMany", ids, to: Math.trunc(raw.to) }
    }
    case "updateMany": {
      const ids = parseIds(raw.ids)
      if (raw.title === undefined && raw.detail === undefined && raw.status === undefined) {
        throw new BoardError("updateMany needs at least one of title, detail, status")
      }
      return {
        op: "updateMany",
        ids,
        title: asOptionalString(raw.title),
        detail: asOptionalString(raw.detail),
        status: asStatus(raw.status),
      }
    }
    case "removeMany": {
      if (!Array.isArray(raw.ids) || raw.ids.length === 0) throw new BoardError("removeMany needs a non-empty `ids` array")
      if (raw.ids.length > 500) throw new BoardError("removeMany takes at most 500 ids")
      const ids = raw.ids.map((id, index) => {
        if (typeof id !== "string") throw new BoardError(`ids[${index}] must be a string`)
        return id
      })
      return { op: "removeMany", ids }
    }
    case "folder":
      if (typeof raw.title !== "string") throw new BoardError("folder needs a title")
      return { op: "folder", title: raw.title, detail: asOptionalString(raw.detail) }
    case "subtask":
      if (typeof raw.parentID !== "string") throw new BoardError("subtask needs a parentID")
      if (typeof raw.title !== "string") throw new BoardError("subtask needs a title")
      return { op: "subtask", parentID: raw.parentID, title: raw.title, detail: asOptionalString(raw.detail) }
    case "subtasks": {
      if (typeof raw.parentID !== "string") throw new BoardError("subtasks needs a parentID")
      const batch = parseOne(0, Array.isArray(raw.items) ? raw.items : undefined)
      void batch
      if (!Array.isArray(raw.items) || raw.items.length === 0) throw new BoardError("subtasks needs a non-empty `items` array")
      if (raw.items.length > 500) throw new BoardError("subtasks takes at most 500 items")
      return { op: "subtasks", parentID: raw.parentID, items: raw.items.map((e, i) => parseOne(i, e)) }
    }
    case "reparent":
      if (typeof raw.id !== "string") throw new BoardError("reparent needs an id")
      if (typeof raw.parentID !== "string") throw new BoardError("reparent needs a parentID (empty string for top level)")
      return { op: "reparent", id: raw.id, parentID: raw.parentID }
    case "move":
      if (typeof raw.id !== "string") throw new BoardError("move needs an id")
      if (typeof raw.to !== "number") throw new BoardError("move needs a numeric `to` index")
      return { op: "move", id: raw.id, to: raw.to }
    case "current":
      return { op: "current", id: asOptionalString(raw.id) }
    case "nudge":
      if (typeof raw.enabled !== "boolean") throw new BoardError("nudge needs `enabled: true|false`")
      return { op: "nudge", enabled: raw.enabled }
    case "debug":
      if (typeof raw.enabled !== "boolean") throw new BoardError("debug needs `enabled: true|false`")
      return { op: "debug", enabled: raw.enabled }
    case "count":
      if (typeof raw.maxAttempts !== "number" || raw.maxAttempts < 1) {
        throw new BoardError("count needs `maxAttempts` of at least 1")
      }
      return { op: "count", maxAttempts: Math.trunc(raw.maxAttempts) }
    case "export":
      return { op: "export", path: asOptionalString(raw.path) }
    case "template":
      return { op: "template", path: asOptionalString(raw.path) }
    case "import": {
      const path = asOptionalString(raw.path)
      const content = asOptionalString(raw.content)
      if (!path && !content) throw new BoardError("import needs a `path`, or the file `content` itself")
      if (raw.merge !== undefined && typeof raw.merge !== "boolean") throw new BoardError("import `merge` must be true or false")
      return { op: "import", path, content, merge: raw.merge, fromHuman: raw.fromHuman === true }
    }
    case "notify":
      if (raw.mode !== "toast" && raw.mode !== "panel") throw new BoardError("notify `mode` must be \"toast\" or \"panel\"")
      return { op: "notify", mode: raw.mode }
    case "composer":
      return { op: "composer", busy: raw.busy === true }
    default:
      return { op: op as "clear" | "pause" | "resume" | "unpause" }
  }
}

/** Parse a batch of ids, naming the offending index so the error is actionable. */
function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BoardError("needs a non-empty `ids` array")
  if (raw.length > 500) throw new BoardError("takes at most 500 ids")
  return raw.map((id, index) => {
    if (typeof id !== "string") throw new BoardError(`ids[${index}] must be a string`)
    return id
  })
}

/** Parse one bulk entry, naming its index so a bad batch says which one. */
function parseOne(index: number, entry: unknown): { title: string; detail?: string; status?: ItemStatus } {
  if (typeof entry !== "object" || entry === null) throw new BoardError(`items[${index}] must be an object`)
  const raw = entry as Record<string, unknown>
  if (typeof raw.title !== "string") throw new BoardError(`items[${index}] needs a title`)
  return { title: raw.title, detail: asOptionalString(raw.detail), status: asStatus(raw.status) }
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

/** The parent must exist. Cycle safety is checked where a tree is built. */
function requireParent(board: Board, parentID: string) {
  if (!board.items.some((item) => item.id === parentID)) throw new BoardError(`no item ${parentID} to nest under`)
}

function nudgeOp(board: Board, next: NudgeState): Board {
  return { ...board, nudge: next }
}

/** Where the checklist lives, relative to the project root. */
const TASKS_PATH = `${TASKS_DIR}/${TASKS_FILE}`
const TEMPLATE_PATH = `${TASKS_DIR}/${TEMPLATE_FILE}`

function requireFiles(io: Store, op: string): Files {
  if (!io.files) throw new BoardError(`${op} needs file access, which this caller did not provide`)
  return io.files
}

/**
 * A Windows path, on any platform.
 *
 * Backslashes are legal in a POSIX filename and a person typing one is almost
 * always copying from a Windows machine or a document that used them. On Linux
 * `path.isAbsolute("C:\\Users\\me\\tasks.md")` is false and `\` is an ordinary
 * character, so the traversal check walks straight past it — the one case where
 * not recognising the path is the security-relevant one. Detecting the shape
 * lets it be refused rather than silently treated as a relative filename.
 */
export function looksAbsolute(value: string): boolean {
  const v = value.replace(/\\/g, "/")
  return path.isAbsolute(v) || path.posix.isAbsolute(v) || /^[A-Za-z]:\//.test(v) || v.startsWith("~")
}

/**
 * Keep a path inside the project, unless a person named it.
 *
 * The agent picks most of these, and an agent can be talked into
 * `../../.ssh/authorized_keys` by anything it reads. So a tool call is confined
 * no matter what it asks for.
 *
 * A human typing a path is different: `/ock import ~/other-repo/tasks.md` is an
 * explicit instruction about a specific file, and refusing it would make the
 * command lie about what it can do. `fromHuman` is the difference, it is set in
 * exactly one place — the slash handler — and it only ever widens *reading*.
 * Writing outside the project stays refused for everyone, because that is the
 * direction with consequences.
 */
export function confinePath(relative: string, options: { allowAbsolute?: boolean } = {}): string {
  const value = relative.replace(/\\/g, "/")
  if (options.allowAbsolute && (value.startsWith("~") || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value))) {
    return value
  }
  if (looksAbsolute(relative)) {
    throw new BoardError(
      options.allowAbsolute ? `path leaves the project root: ${relative}` : `path must be relative to the project root: ${relative}`,
    )
  }
  const resolved = path.posix.normalize(value)
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new BoardError(`path leaves the project root: ${relative}`)
  }
  return resolved
}

async function writeFileIn(io: Store, relative: string, content: string): Promise<string> {
  const safe = confinePath(relative)
  await requireFiles(io, "writing a file").write(safe, content)
  return safe
}

async function readFileIn(io: Store, relative: string, fromHuman: boolean): Promise<string> {
  const safe = confinePath(relative, { allowAbsolute: fromHuman })
  try {
    return await requireFiles(io, "reading a file").read(safe)
  } catch {
    // The message names the default, because that is the path 9 times out of 10
    // someone meant and the one the help tells them about.
    throw new BoardError(`no readable file at ${safe} — export first, or pass the file's content instead`)
  }
}

async function exportBoard(io: Store, board: Board, override: string | undefined, now: number): Promise<string> {
  return writeFileIn(io, override ?? TASKS_PATH, renderTasks(board, new Date(now)))
}

/**
 * Turn a parsed checklist into board items.
 *
 * Parents are created before their children, because a child cannot be filed
 * under something that does not exist yet. Any node with children becomes a
 * container: marking one done by hand is refused, and that would be a surprising
 * rule to inherit from a file that looked like a plain checklist.
 */
function buildTree(board: Board, roots: ParsedNode[], now: number): { board: Board; count: number } {
  let next = board
  let count = 0
  const walk = (nodes: ParsedNode[], parentID: string | undefined) => {
    for (const node of nodes) {
      const container = node.children.length > 0
      const result = addItem(next, { title: node.title, detail: node.detail, status: node.status, ...(parentID ? { parentID } : {}) }, now)
      next = result.board
      count += 1
      // A container's own checkbox is derived, so importing a file that ticked
      // every box must not import it as a self-closing folder.
      if (container) {
        next = { ...next, items: next.items.map((item) => (item.id === result.item.id ? { ...item, status: "pending" as ItemStatus } : item)) }
        walk(node.children, result.item.id)
      }
    }
  }
  walk(roots, undefined)
  return { board: { ...next, currentID: undefined }, count }
}

/**
 * Apply one mutation: read, reduce, apply the progress rule, persist.
 * Throws `BoardError` with a message fit to show a user.
 */
export async function apply(store: Store, sessionID: string, mutation: Mutation, now = Date.now()): Promise<ApplyResult> {
  const io = store
  const before = await store.read(sessionID)
  const board = before ?? freshBoard(sessionID)

  let next: Board
  let message: string
  /**
   * Operations that touch the project instead of the board.
   *
   * They still go through here rather than being handled in the tool, because
   * one write path is the only reason there is a single place to look when a
   * board ends up in a state nobody expected.
   */
  let wrote: string | undefined

  switch (mutation.op) {
    case "export": {
      const target = await exportBoard(io, board, mutation.path, now)
      wrote = target
      next = board
      message = `exported ${board.items.length} task(s) to ${target}`
      break
    }
    case "template": {
      const target = await writeFileIn(io, mutation.path ?? TEMPLATE_PATH, TEMPLATE)
      wrote = target
      next = board
      message = `wrote a starter template to ${target}`
      break
    }
    case "import": {
      // No path means the standard file. `/ock import` with no arguments is the
      // common case — restoring what `/ock export` wrote — and making someone
      // name a path they did not choose is a question with one answer.
      const text = mutation.content ?? (await readFileIn(io, mutation.path ?? TASKS_PATH, mutation.fromHuman === true))
      const roots = parseTasks(text)
      // Replace starts from an empty board. Building onto the existing one and
      // then calling it a replacement is how "replace" silently became "append",
      // which is the worst possible failure for the one call whose whole job is
      // to lose what is there. The nudge state is kept either way — a restore is
      // not a reason to forget how many tries the board has left.
      const base = mutation.merge === false ? freshBoard(sessionID) : board
      const imported = buildTree(base, roots, now)
      next = imported.board
      message = `imported ${imported.count} task(s) from ${mutation.content ? "the text given" : (mutation.path ?? TASKS_PATH)}`
      break
    }
    case "notify": {
      next = { ...board, notify: mutation.mode, updatedAt: now }
      message = mutation.mode === "panel" ? "notifying in the window" : "notifying as toasts"
      break
    }
    case "add": {
      const result = addItem(board, mutation, now)
      next = result.board
      message = `added ${result.item.id}: ${result.item.title}`
      break
    }
    case "moveMany": {
      const missing = mutation.ids.filter((id) => !board.items.some((item) => item.id === id))
      if (missing.length > 0) throw new BoardError(`no such item(s): ${missing.slice(0, 5).join(", ")}`)
      // Take them out in the order given, then drop the whole run back at the
      // target so the caller controls their final order too.
      const moved = mutation.ids.map((id) => board.items.find((item) => item.id === id)!)
      const rest = board.items.filter((item) => !mutation.ids.includes(item.id))
      const target = mutation.to === -1 ? rest.length : Math.max(0, Math.min(mutation.to, rest.length))
      const items = [...rest.slice(0, target), ...moved, ...rest.slice(target)]
      next = { ...board, items, updatedAt: now }
      message = `moved ${mutation.ids.length} item(s) to position ${target + 1}`
      break
    }
    case "updateMany": {
      const missing = mutation.ids.filter((id) => !board.items.some((item) => item.id === id))
      if (missing.length > 0) throw new BoardError(`no such item(s): ${missing.slice(0, 5).join(", ")}`)
      // One in_progress at a time: promoting a batch demotes the rest.
      const items = board.items.map((item) => {
        if (!mutation.ids.includes(item.id)) {
          if (mutation.status === "in_progress" && item.status === "in_progress") {
            return { ...item, status: "pending" as ItemStatus, updatedAt: now }
          }
          return item
        }
        const title = mutation.title === undefined ? item.title : clampTitleSafe(mutation.title)
        const detail = mutation.detail === undefined ? item.detail : mutation.detail || undefined
        return {
          ...item,
          title,
          detail,
          status: mutation.status ?? item.status,
          updatedAt: now,
        }
      })
      next = { ...board, items, updatedAt: now }
      message = `updated ${mutation.ids.length} item(s)`
      break
    }
    case "addMany": {
      // Build the whole batch before writing any of it, so one bad item cannot
      // leave a half-built plan on the board.
      let staged = board
      const ids: string[] = []
      for (const item of mutation.items) {
        const result = addItem(staged, item, now)
        staged = result.board
        ids.push(result.item.id)
      }
      next = staged
      message = `added ${ids.length} task(s): ${ids[0]}..${ids[ids.length - 1]}`
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
    case "removeMany": {
      // Check every id first: removing 68 and failing on the 69th would leave a
      // half-trimmed board that looks deliberate.
      const missing = mutation.ids.filter((id) => !board.items.some((item) => item.id === id))
      if (missing.length > 0) throw new BoardError(`no such item(s): ${missing.slice(0, 5).join(", ")}`)
      let staged = board
      for (const id of mutation.ids) staged = removeItem(staged, id, now)
      next = staged
      message = `removed ${mutation.ids.length} item(s)`
      break
    }
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
    case "debug":
      next = { ...board, debug: mutation.enabled, updatedAt: now }
      message = mutation.enabled ? `debug logging on -> ${DEBUG_LOG}` : "debug logging off"
      break
    case "nudge":
      next = { ...board, nudge: { ...board.nudge, enabled: mutation.enabled, lastResult: mutation.enabled ? "nudging on" : "nudging off" }, updatedAt: now }
      message = mutation.enabled ? "nudging switched on" : "nudging switched off"
      break
    case "count":
      next = {
        ...board,
        nudge: { ...board.nudge, maxAttempts: mutation.maxAttempts, attempts: 0, halted: false, lastResult: `budget ${mutation.maxAttempts}` },
        updatedAt: now,
      }
      message = `nudge budget set to ${mutation.maxAttempts}`
      break
    case "folder": {
      const result = addItem(board, { title: mutation.title, detail: mutation.detail }, now)
      next = result.board
      message = `folder ${result.item.id}: ${result.item.title}`
      break
    }
    case "subtask": {
      requireParent(board, mutation.parentID)
      const result = addItem(board, { title: mutation.title, detail: mutation.detail, parentID: mutation.parentID }, now)
      next = result.board
      message = `subtask ${result.item.id} under ${mutation.parentID}: ${result.item.title}`
      break
    }
    case "subtasks": {
      requireParent(board, mutation.parentID)
      let staged = board
      const ids: string[] = []
      for (const item of mutation.items) {
        const result = addItem(staged, { ...item, parentID: mutation.parentID }, now)
        staged = result.board
        ids.push(result.item.id)
      }
      next = staged
      message = `added ${ids.length} subtask(s) to ${mutation.parentID}: ${ids[0]}..${ids[ids.length - 1]}`
      break
    }
    case "reparent": {
      const parent = mutation.parentID || undefined
      if (parent) {
        requireParent(board, parent)
        if (wouldCycle(board, mutation.id, parent)) throw new BoardError("that would nest a folder inside itself")
      }
      next = {
        ...board,
        items: board.items.map((item) => (item.id === mutation.id ? { ...item, parentID: parent, updatedAt: now } : item)),
        updatedAt: now,
      }
      message = parent ? `moved ${mutation.id} under ${parent}` : `${mutation.id} moved to top level`
      break
    }
    case "composer":
      next = { ...board, composerBusy: mutation.busy, updatedAt: now }
      message = mutation.busy ? "composer marked busy" : "composer marked free"
      break
    default: {
      const exhaustive: never = mutation
      throw new BoardError(`unsupported op ${JSON.stringify(exhaustive)}`)
    }
  }

  const final = { ...closeCompletedAncestors(withProgressPolicy(board, next), now), updatedAt: now }
  // Export and template do not change the board, so writing it back would only
  // risk touching the file for nothing. Import and notify do change it.
  if (!wrote) await store.write(final)
  return { board: final, message, ...(wrote ? { wrote } : {}) }
}

/** Title validation for bulk updates; mirrors what the single-item path does. */
function clampTitleSafe(value: string): string {
  const title = value.trim()
  if (!title) throw new BoardError("title must not be empty")
  if (title.length > 200) throw new BoardError("title must be at most 200 characters")
  return title
}

/** Reset the counter when an item completes — exposed for the write tool. */
export function onItemCompleted(board: Board): Board {
  return { ...board, nudge: noteProgress(board.nudge) }
}