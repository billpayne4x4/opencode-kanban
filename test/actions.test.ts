import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { apply, parseMutation, type Mutation, type Store } from "../src/actions.ts"
import { renderBoard, nudgeToast, statusGlyph, truncate, progressLabel, checkbox, panelTitle, panelRule, EMPTY_BOARD } from "../src/format.ts"
import * as store from "../src/store.ts"
import { addItem } from "../src/board.ts"
import { type Board, freshBoard } from "../src/types.ts"

const NOW = 1_700_000_000_000

async function tempWorktree(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "kanban-test-"))
}

/** An in-memory Store, for testing apply() without touching disk. */
function memoryStore(seed?: Board): Store & { board: Board } {
  const state = { board: seed ?? freshBoard("ses_test") }
  return {
    get board() {
      return state.board
    },
    async read() {
      return state.board
    },
    async write(board) {
      state.board = board
    },
  }
}

describe("parseMutation", () => {
  it("accepts every documented op", () => {
    assert.deepEqual(parseMutation({ op: "add", title: "a" }), { op: "add", title: "a", detail: undefined, status: undefined })
    assert.deepEqual(parseMutation({ op: "remove", id: "k1" }), { op: "remove", id: "k1" })
    assert.deepEqual(parseMutation({ op: "move", id: "k1", to: 2 }), { op: "move", id: "k1", to: 2 })
    assert.deepEqual(parseMutation({ op: "clear" }), { op: "clear" })
    assert.deepEqual(parseMutation({ op: "current", id: "k1" }), { op: "current", id: "k1" })
  })

  it("rejects junk with a message a model can act on", () => {
    assert.throws(() => parseMutation(null), /must be an object/)
    assert.throws(() => parseMutation({ op: "frobnicate" }), /op must be one of/)
    assert.throws(() => parseMutation({ op: "add" }), /add needs a title/)
    assert.throws(() => parseMutation({ op: "remove" }), /remove needs an id/)
    assert.throws(() => parseMutation({ op: "move", id: "k1" }), /numeric/)
    assert.throws(() => parseMutation({ op: "add", title: "a", status: "sideways" }), /pending, in_progress/)
  })

  it("treats an explicit null detail as clearing it", () => {
    const mutation = parseMutation({ op: "update", id: "k1", detail: null }) as Extract<Mutation, { op: "update" }>
    assert.equal(mutation.detail, undefined)
  })
})

describe("apply", () => {
  it("adds, then reports progress", async () => {
    const io = memoryStore()
    const added = await apply(io, "ses_test", { op: "add", title: "Fix the compiler" }, NOW)
    assert.equal(added.board.items.length, 1)
    assert.match(added.message, /added k1: Fix the compiler/)

    const done = await apply(io, "ses_test", { op: "update", id: "k1", status: "done" }, NOW)
    assert.equal(done.board.items[0].status, "done")
    assert.deepEqual(progressLabel(done.board), "1/1 done")
  })

  it("resets the nudge counter when an item is finished", async () => {
    const io = memoryStore({ ...freshBoard("ses_test"), nudge: { attempts: 2, halted: true, paused: false } })
    const result = await apply(io, "ses_test", { op: "add", title: "a" }, NOW)
    // add only, so the counter survives
    assert.equal(result.board.nudge.attempts, 2)

    const finished = await apply(io, "ses_test", { op: "update", id: "k1", status: "done" }, NOW)
    assert.equal(finished.board.nudge.attempts, 0)
    assert.equal(finished.board.nudge.halted, false)
  })

  it("pause, resume and unpause move only what they claim to", async () => {
    const io = memoryStore({ ...freshBoard("ses_test"), nudge: { attempts: 2, halted: true, paused: false } })
    assert.equal((await apply(io, "ses_test", { op: "pause" }, NOW)).board.nudge.paused, true)
    assert.equal((await apply(io, "ses_test", { op: "unpause" }, NOW)).board.nudge.attempts, 2)
    const resumed = await apply(io, "ses_test", { op: "resume" }, NOW)
    assert.equal(resumed.board.nudge.attempts, 0)
    assert.equal(resumed.board.nudge.paused, false)
  })

  it("records composer busy without touching the work", async () => {
    const io = memoryStore()
    await apply(io, "ses_test", { op: "add", title: "a" }, NOW)
    const busy = await apply(io, "ses_test", { op: "composer", busy: true }, NOW)
    assert.equal(busy.board.composerBusy, true)
    assert.equal(busy.board.items.length, 1)
    assert.equal((await apply(io, "ses_test", { op: "composer", busy: false }, NOW)).board.composerBusy, false)
  })

  it("propagates a reducer error rather than writing", async () => {
    const io = memoryStore()
    await assert.rejects(() => apply(io, "ses_test", { op: "remove", id: "k9" }, NOW), /no item k9/)
    assert.equal(io.board.items.length, 0)
  })
})

describe("store round trip", () => {
  it("saves and reloads a board", async () => {
    const worktree = await tempWorktree()
    const board = { ...freshBoard("ses_1"), items: [{ id: "k1", title: "t", status: "done" as const, createdAt: 1, updatedAt: 1 }] }
    await store.save(worktree, board)
    const reloaded = await store.load(worktree, "ses_1")
    assert.equal(reloaded.items[0].title, "t")
    assert.equal(reloaded.items[0].status, "done")
  })

  it("keeps other sessions untouched", async () => {
    const worktree = await tempWorktree()
    await store.save(worktree, { ...freshBoard("ses_1") })
    const second = { ...freshBoard("ses_2") }
    await store.save(worktree, second)
    const files = await readdir(store.stateDir(worktree))
    assert.ok(files.includes(store.STATE_FILE))
    assert.equal((await store.load(worktree, "ses_1")).sessionID, "ses_1")
    assert.equal((await store.load(worktree, "ses_2")).sessionID, "ses_2")
  })

  it("returns a fresh board when nothing has been written yet", async () => {
    const worktree = await tempWorktree()
    const board = await store.load(worktree, "ses_new")
    assert.equal(board.sessionID, "ses_new")
    assert.equal(board.items.length, 0)
  })

  it("quarantines a corrupt file instead of destroying it", async () => {
    const worktree = await tempWorktree()
    await store.save(worktree, freshBoard("ses_1"))
    const target = store.statePath(worktree)
    await writeFile(target, "{ this is not json", "utf8")

    const board = await store.load(worktree, "ses_1")
    assert.equal(board.items.length, 0, "the caller gets a clean board")

    const quarantined = (await readdir(store.stateDir(worktree))).filter((f) => f.includes(".corrupt-"))
    assert.equal(quarantined.length, 1, "the bad file is kept for inspection")
    const original = await readFile(path.join(store.stateDir(worktree), quarantined[0]), "utf8")
    assert.equal(original, "{ this is not json")
  })

  it("quarantines valid JSON that is the wrong shape", async () => {
    const worktree = await tempWorktree()
    await store.save(worktree, freshBoard("ses_1"))
    await writeFile(store.statePath(worktree), '{"version":1,"boards":"nope"}', "utf8")
    assert.equal((await store.load(worktree, "ses_1")).items.length, 0)
    assert.ok((await readdir(store.stateDir(worktree))).some((f) => f.includes(".corrupt-")))
  })

  it("forget drops only the named session", async () => {
    const worktree = await tempWorktree()
    await store.save(worktree, freshBoard("ses_1"))
    await store.save(worktree, freshBoard("ses_2"))
    await store.forget(worktree, "ses_1")
    assert.equal((await store.load(worktree, "ses_1")).items.length, 0)
    assert.ok((await readFile(store.statePath(worktree), "utf8")).includes("ses_2"))
  })

  it("writes atomically, leaving no temp files behind", async () => {
    const worktree = await tempWorktree()
    await store.save(worktree, freshBoard("ses_1"))
    await store.save(worktree, freshBoard("ses_1"))
    const files = await readdir(store.stateDir(worktree))
    assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [])
  })
})

describe("format", () => {
  it("glyphs map from status", () => {
    assert.equal(statusGlyph("done"), "✓")
    assert.equal(statusGlyph("in_progress"), "▸")
    assert.equal(statusGlyph("blocked"), "!")
    assert.equal(statusGlyph("pending"), "·")
  })

  it("truncate leaves short text alone and elides the rest", () => {
    assert.equal(truncate("abc", 5), "abc")
    assert.equal(truncate("abcdef", 3), "ab…")
    assert.equal(truncate("abcdef", 1), "…")
    assert.equal(truncate("abcdef", 0), "")
  })

  it("the heading is OpenCode Kanban (done/total)", () => {
    assert.equal(panelTitle(2, 5), "OpenCode Kanban (2/5)")
    assert.equal(panelTitle(0, 0), "OpenCode Kanban (0/0)")
    assert.equal(panelTitle(3, 3), "OpenCode Kanban (3/3)")
  })

  it("the rule spans the given width", () => {
    assert.equal([...panelRule(40)].length, 40)
    assert.equal([...panelRule(panelTitle(2, 5).length)].length, panelTitle(2, 5).length)
    assert.equal(panelRule(0), "─", "never zero-width, which would hide the row")
    assert.equal(panelRule(-5), "─", "a bad measurement must not throw")
    assert.equal(panelRule(12.9), "─".repeat(12), "fractions truncate to whole cells")
  })

  it("only a done item gets a ticked box", () => {
    assert.equal(checkbox("done"), "[x]")
    assert.equal(checkbox("pending"), "[ ]")
    assert.equal(checkbox("in_progress"), "[ ]")
    assert.equal(checkbox("blocked"), "[ ]")
  })

  it("the empty-board string is for dialogs, not the panel", () => {
    assert.match(EMPTY_BOARD, /no tasks/i)
    assert.doesNotMatch(EMPTY_BOARD, /kanban-add/, "the panel must not point at commands")
  })

  it("renderBoard says something useful when empty", () => {
    const text = renderBoard(freshBoard("ses_1"))
    assert.match(text, /Board is empty/)
    assert.match(text, /0\/0 done/)
  })

  it("renderBoard includes detail and the current marker", () => {
    let board = freshBoard("ses_1")
    board = { ...board, items: [{ id: "k1", title: "Fix", detail: "passes tests", status: "in_progress", createdAt: 0, updatedAt: 0 }], currentID: "k1" }
    const text = renderBoard(board)
    assert.match(text, /▸ k1 · Fix \(current\)/)
    assert.match(text, /detail: passes tests/)
  })

  it("renderBoard indents the tree so nesting is visible", () => {
    // Regression: rows came out in creation order, so a parent and its child
    // drew side by side and the board read as a flat list.
    let board = addItem(freshBoard("ses_1"), { title: "Phase 1" }, 0).board
    board = addItem(board, { title: "Lowering", parentID: "k1" }, 0).board
    board = addItem(board, { title: "Audit eval.rs", parentID: "k2" }, 0).board
    board = addItem(board, { title: "Unrelated" }, 0).board
    const rows = renderBoard(board).split("\n").filter((line) => /^[ ·✓▸!\[]/.test(line) && /\bk\d/.test(line))
    assert.deepEqual(
      rows.map((line) => line.replace(/^(\s*)\[[ x]\]\s*/, "$1").replace(/^(\s*)[·✓▸!]\s*/, "$1").trim()),
      ["k1 · Phase 1", "k2 · Lowering", "k3 · Audit eval.rs", "k4 · Unrelated"],
    )
    // Indent per level, and a checkbox on containers: "pending" is not a state
    // a container can be in, since it has no work of its own.
    assert.match(rows[0]!, /^\[ \] k1 /, "a root container sits at the left margin")
    assert.match(rows[1]!, /^ {2}\[ \] k2 /, "a child container is one step in")
    assert.match(rows[2]!, /^ {4}· k3 /, "a grandchild task is two steps in")
    assert.match(rows[3]!, /^· k4 /, "a later root is back at the margin, not under the tree")
  })

  it("nudgeToast warns before the last try", () => {
    assert.match(nudgeToast({ id: "k1", title: "Fix", status: "pending", createdAt: 0, updatedAt: 0 }, 1, 3, false), /2 left/)
    assert.match(nudgeToast({ id: "k1", title: "Fix", status: "pending", createdAt: 0, updatedAt: 0 }, 3, 3, true), /last try/)
  })
})