import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import {
  BoardError,
  addItem,
  clearBoard,
  hasOpenWork,
  isFolder,
  containerDone,
  descendantProgress,
  madeProgress,
  nextID,
  nextItem,
  closeCompletedAncestors,
  normalizeBoard,
  wouldCycle,
  progress,
  removeItem,
  reorder,
  setCurrent,
  updateItem,
} from "../src/board.ts"
import { freshBoard } from "../src/types.ts"
import { renderBoard } from "../src/format.ts"

const NOW = 1_700_000_000_000

function withItems(count: number) {
  let board = freshBoard("ses_test")
  for (let i = 0; i < count; i += 1) {
    board = addItem(board, { title: `task ${i + 1}` }, NOW).board
  }
  return board
}

describe("ids", () => {
  it("numbers from one and never collides after a delete", () => {
    const board = withItems(3)
    assert.deepEqual(board.items.map((item) => item.id), ["k1", "k2", "k3"])
    const withoutMiddle = removeItem(board, "k2", NOW)
    // Reuses the highest number rather than the length, so k4 is not k3.
    assert.equal(nextID(withoutMiddle), "k4")
  })

  it("starts at k1 on an empty board and skips foreign ids", () => {
    assert.equal(nextID(freshBoard("s")), "k1")
    const withForeign = {
      ...freshBoard("s"),
      items: [{ id: "external-1", title: "x", status: "pending" as const, createdAt: 0, updatedAt: 0 }],
    }
    assert.equal(nextID(withForeign), "k1", "a non-k id must not raise the counter")
  })
})

describe("add", () => {
  it("defaults to pending and stamps both times", () => {
    const { board, item } = addItem(freshBoard("s"), { title: "  Fix it  " }, NOW)
    assert.equal(item.title, "Fix it")
    assert.equal(item.status, "pending")
    assert.equal(item.createdAt, NOW)
    assert.equal(item.updatedAt, NOW)
    assert.equal(board.items.length, 1)
  })

  it("rejects an empty or whitespace title", () => {
    assert.throws(() => addItem(freshBoard("s"), { title: "   " }, NOW), BoardError)
  })

  it("rejects an over-long title rather than truncating it", () => {
    assert.throws(() => addItem(freshBoard("s"), { title: "x".repeat(201) }, NOW), /at most 200/)
  })

  it("keeps only one item in progress", () => {
    let board = addItem(freshBoard("s"), { title: "a", status: "in_progress" }, NOW).board
    board = addItem(board, { title: "b", status: "in_progress" }, NOW).board
    const active = board.items.filter((item) => item.status === "in_progress")
    assert.equal(active.length, 1)
    assert.equal(active[0].id, "k2")
  })
})

describe("update", () => {
  it("only touches the keys it is given", () => {
    const board = addItem(freshBoard("s"), { title: "a", detail: "keep me" }, NOW).board
    const next = updateItem(board, "k1", { status: "done" }, NOW)
    assert.equal(next.items[0].title, "a")
    assert.equal(next.items[0].detail, "keep me")
    assert.equal(next.items[0].status, "done")
  })

  it("hands the baton when the current item is finished", () => {
    let board = addItem(freshBoard("s"), { title: "a" }, NOW).board
    board = addItem(board, { title: "b" }, NOW).board
    board = setCurrent(board, "k1", NOW)
    const next = updateItem(board, "k1", { status: "done" }, NOW)
    assert.equal(next.currentID, "k2")
  })

  it("throws on an unknown id and on a no-op patch", () => {
    const board = withItems(1)
    assert.throws(() => updateItem(board, "k9", { status: "done" }, NOW), /no item k9/)
    assert.throws(() => updateItem(board, "k1", {}, NOW), /at least one/)
  })
})

describe("remove / move / clear", () => {
  it("advances current when the current item is removed", () => {
    let board = withItems(3)
    board = setCurrent(board, "k2", NOW)
    const next = removeItem(board, "k2", NOW)
    // The successor is the first pending item left, in board order.
    assert.deepEqual(next.items.map((item) => item.id), ["k1", "k3"])
    assert.equal(next.currentID, "k1")
  })

  it("keeps current when some other item is removed", () => {
    let board = withItems(3)
    board = setCurrent(board, "k2", NOW)
    assert.equal(removeItem(board, "k1", NOW).currentID, "k2")
  })

  it("clears current when nothing is left to hand over to", () => {
    let board = withItems(1)
    board = setCurrent(board, "k1", NOW)
    assert.equal(removeItem(board, "k1", NOW).currentID, undefined)
  })

  it("clamps a move index into range", () => {
    const board = withItems(3)
    assert.equal(reorder(board, "k1", 99, NOW).items.map((i) => i.id)[2], "k1")
    assert.equal(reorder(board, "k1", -5, NOW).items.map((i) => i.id)[0], "k1")
  })

  it("clear empties items but keeps identity and nudge policy", () => {
    const board = { ...withItems(2), nudge: { attempts: 2, halted: false, paused: false } }
    const next = clearBoard(board, NOW)
    assert.equal(next.items.length, 0)
    assert.equal(next.sessionID, board.sessionID)
    assert.equal(next.nudge.attempts, 2)
  })
})

describe("queries", () => {
  it("counts progress and open work", () => {
    let board = withItems(3)
    board = updateItem(board, "k1", { status: "done" }, NOW)
    assert.deepEqual(progress(board), { done: 1, total: 3 })
    assert.equal(hasOpenWork(board), true)
    board = updateItem(board, "k2", { status: "done" }, NOW)
    board = updateItem(board, "k3", { status: "done" }, NOW)
    assert.equal(hasOpenWork(board), false)
  })

  it("an empty board has no open work, so nothing to nudge", () => {
    assert.equal(hasOpenWork(freshBoard("s")), false)
    assert.equal(nextItem(freshBoard("s")), undefined)
  })

  it("next item prefers current, then in-progress, then pending", () => {
    let board = withItems(3)
    board = updateItem(board, "k2", { status: "in_progress" }, NOW)
    assert.equal(nextItem(board)?.id, "k2", "in_progress wins when nothing is current")
    board = setCurrent(board, "k3", NOW)
    assert.equal(nextItem(board)?.id, "k3")
  })

  it("next item falls through when current is already done", () => {
    let board = withItems(2)
    board = setCurrent(board, "k1", NOW)
    board = updateItem(board, "k1", { status: "done" }, NOW)
    assert.equal(nextItem(board)?.id, "k2")
  })

  it("detects an item reaching done as progress", () => {
    const before = withItems(2)
    const after = updateItem(before, "k1", { status: "done" }, NOW)
    assert.equal(madeProgress(before, after), true)
    assert.equal(madeProgress(after, after), false)
    assert.equal(madeProgress(after, reorder(after, "k1", 1, NOW)), false)
  })
})

describe("normalizeBoard", () => {
  it("returns a fresh board for junk input", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      assert.equal(normalizeBoard(junk, "s").items.length, 0)
    }
  })

  it("drops malformed items and bad statuses instead of failing", () => {
    const board = normalizeBoard(
      {
        items: [
          { id: "k1", title: "good", status: "nonsense" },
          { id: 7, title: "bad id" },
          { title: "no id" },
          null,
        ],
        currentID: "k9",
        nudge: { attempts: 2 },
      },
      "s",
    )
    assert.equal(board.items.length, 1)
    assert.equal(board.items[0].status, "pending", "an unknown status becomes pending")
    assert.equal(board.currentID, undefined, "a currentID pointing nowhere is dropped")
    assert.equal(board.nudge.attempts, 2)
    assert.equal(board.nudge.paused, false, "missing nudge fields get defaults")
  })

  it("keeps a valid currentID", () => {
    const board = normalizeBoard({ items: [{ id: "k1", title: "a" }], currentID: "k1" }, "s")
    assert.equal(board.currentID, "k1")
  })
})
describe("nesting", () => {
  it("refuses to file a folder inside its own descendant", () => {
    // Regression: the guard asked "is the child already under the parent",
    // which is true for every legal re-file and false for every real loop.
    const board = {
      ...freshBoard("s"),
      items: [
        { id: "k1", title: "parent", status: "pending" as const, createdAt: 0, updatedAt: 0 },
        { id: "k2", title: "child", status: "pending" as const, createdAt: 0, updatedAt: 0, parentID: "k1" },
      ],
    }
    assert.equal(wouldCycle(board, "k1", "k2"), true, "k2 is inside k1, so k1 cannot go under k2")
    assert.equal(wouldCycle(board, "k1", "k1"), true, "a folder cannot contain itself")
    assert.equal(wouldCycle(board, "k2", "k1"), false, "moving a child up to its parent is fine")
    assert.equal(wouldCycle(board, "k9", "k1"), false, "an unrelated item is fine")
  })

  it("a folder closes once every descendant closes", () => {
    let board = addItem(freshBoard("s"), { title: "parent" }, NOW).board
    board = addItem(board, { title: "a", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "b", parentID: "k1" }, NOW).board
    board = updateItem(board, "k2", { status: "done" }, NOW)
    assert.notEqual(closeCompletedAncestors(board, NOW).items[0]!.status, "done", "one child still open")
    board = updateItem(board, "k3", { status: "done" }, NOW)
    assert.equal(closeCompletedAncestors(board, NOW).items[0]!.status, "done", "both children done")
  })
})

describe("what the marker points at", () => {
  // Regression: `nextItem` returned the first pending item, which on a nested
  // board is almost always a folder. The marker sat on a container the agent
  // cannot mark done, and the "next up" pointer told it to finish something with
  // no finish to it. The panel and the nudge both follow this function, so one
  // fix covered both — and the second copy of the rule inside `renderBoard` had
  // to go too, because two definitions means two behaviours.
  function nested() {
    let board = addItem(freshBoard("s"), { title: "Phase 1" }, NOW).board
    board = addItem(board, { title: "first task", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "second task", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "Phase 2" }, NOW).board
    board = addItem(board, { title: "later task", parentID: "k4" }, NOW).board
    return board
  }

  it("descends into a container instead of pointing at it", () => {
    const board = nested()
    const next = nextItem(board)
    assert.equal(next?.title, "first task", "the marker must land on work, not on a grouping")
    assert.ok(next && !isFolder(board, next.id), "and never on a container")
  })

  it("still descends when the container was set current by hand", () => {
    // Pointing at a phase means "work on this phase" — not "finish the phase",
    // which nobody can do by hand.
    const board = { ...nested(), currentID: "k4" }
    assert.equal(nextItem(board)?.title, "later task")
  })

  it("skips a done task to find the next one open", () => {
    const board = updateItem(nested(), "k2", { status: "done" }, NOW)
    assert.equal(nextItem(board)?.title, "second task")
  })

  it("descends more than one level", () => {
    let board = addItem(freshBoard("s"), { title: "L1" }, NOW).board
    board = addItem(board, { title: "L2", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "L3 task", parentID: "k2" }, NOW).board
    assert.equal(nextItem(board)?.title, "L3 task")
  })

  it("points at the container only when it has nothing to descend to", () => {
    // Defensive: an empty container is the only thing on the board, and
    // pointing at nothing would leave the panel with no marker at all.
    const board = addItem(freshBoard("s"), { title: "Phase 1" }, NOW).board
    assert.equal(nextItem(board)?.title, "Phase 1")
  })

  it("agrees with the marker: the pointer line uses the same rule", () => {
    const board = nested()
    assert.match(renderBoard(board), new RegExp(`Next up[^\\n]*${nextItem(board)!.title}`))
  })
})

describe("how a container reports itself", () => {
  // The panel's `(2/6)` and the box in front of a folder both come from here,
  // and both must count the whole subtree. Counting one level is how a group
  // reports itself finished while work is still open two levels down.
  function threeDeep() {
    let board = addItem(freshBoard("s"), { title: "L1" }, NOW).board
    board = addItem(board, { title: "L2", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "L3", parentID: "k2" }, NOW).board
    board = addItem(board, { title: "L2 sibling", parentID: "k1" }, NOW).board
    board = addItem(board, { title: "elsewhere" }, NOW).board
    return board
  }

  it("counts every leaf beneath it, at any depth", () => {
    // k1 -> k2 -> k3, and k1 -> k4. The leaves are k3 and k4: two units of
    // work. k2 is a container and is not one, and counting it would make the
    // number depend on whether `closeCompletedAncestors` has run yet.
    assert.deepEqual(descendantProgress(threeDeep(), "k1"), { done: 0, total: 2 })
    assert.deepEqual(descendantProgress(threeDeep(), "k2"), { done: 0, total: 1 })
  })

  it("is not complete while any leaf below it, at any depth, is open", () => {
    let board = threeDeep()
    board = updateItem(board, "k3", { status: "done" }, NOW)
    // The leaf two levels down is closed; a direct sibling is still open.
    assert.equal(containerDone(board, "k1"), false, "a sibling is still open")
    assert.equal(containerDone(board, "k2"), true, "but k2 has nothing left under it")
    board = updateItem(board, "k4", { status: "done" }, NOW)
    assert.equal(containerDone(board, "k1"), true, "the last leaf closed it")
    assert.deepEqual(descendantProgress(board, "k1"), { done: 2, total: 2 })
  })

  it("completes when the last grandchild closes, without being ticked", () => {
    let board = threeDeep()
    board = updateItem(board, "k4", { status: "done" }, NOW)
    assert.equal(containerDone(board, "k1"), false)
    const before = board
    board = updateItem(board, "k3", { status: "done" }, NOW)
    // The leaf closing is the only edit; the container's own box follows from it.
    assert.equal(containerDone(board, "k1"), true)
    assert.deepEqual(descendantProgress(board, "k1"), { done: 2, total: 2 })
    assert.notEqual(before.items[0]!.status, "done", "it was not ticked by hand at any point")
  })

  it("never reports a leafless container as complete", () => {
    // A container with nothing under it has not achieved anything, and a bare
    // `[x]` on an empty folder would read as a finished phase.
    const board = addItem(freshBoard("s"), { title: "empty" }, NOW).board
    assert.equal(containerDone(board, "k1"), false)
  })

  it("ignores work outside it", () => {
    const board = threeDeep()
    assert.equal(descendantProgress(board, "k5").total, 0, "a plain task has no descendants")
  })
})
