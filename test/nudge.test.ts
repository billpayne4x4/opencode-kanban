import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { addItem, updateItem } from "../src/board.ts"
import {
  DEFAULT_MAX_ATTEMPTS,
  composerBlocksNudge,
  decideNudge,
  nudgeLabel,
  nudgeText,
  noteProgress,
  pause,
  resume,
  unpause,
  withProgressPolicy,
} from "../src/nudge.ts"
import { type Board, freshBoard } from "../src/types.ts"

const NOW = 1_700_000_000_000

function boardWith(...titles: string[]): Board {
  let board = freshBoard("ses_test")
  for (const title of titles) board = addItem(board, { title }, NOW).board
  return board
}

/** Run the decision and fold the new nudge state back onto the board. */
function step(board: Board, options = {}): { board: Board; decision: ReturnType<typeof decideNudge> } {
  const decision = decideNudge(board, { now: NOW, ...options })
  return { board: { ...board, nudge: decision.nudge }, decision }
}

describe("the happy path: three nudges then a halt", () => {
  it("fires exactly maxAttempts times, then stops", () => {
    let board = boardWith("a", "b")
    const fires: boolean[] = []

    for (let i = 0; i < 6; i += 1) {
      const result = step(board)
      board = result.board
      fires.push(result.decision.fire)
    }

    assert.deepEqual(fires, [true, true, true, false, false, false])
    assert.equal(board.nudge.attempts, DEFAULT_MAX_ATTEMPTS)
    assert.equal(board.nudge.halted, true)
  })

  it("the third nudge is the last one, not the fourth", () => {
    let board = boardWith("a")
    for (let i = 0; i < 3; i += 1) board = step(board).board
    // Halt is set on the third, not one nudge later.
    assert.equal(board.nudge.halted, true)
    assert.equal(step(board).decision.fire, false)
  })

  it("halts with a reason that names the assumption", () => {
    let board = boardWith("a")
    board = { ...board, nudge: { attempts: 3, halted: false, paused: false } }
    const decision = decideNudge(board, { maxAttempts: 3, now: NOW })
    assert.equal(decision.fire, false)
    assert.equal(decision.nudge.halted, true, "a persisted counter at the cap halts")
    assert.match(decision.reason, /assuming you wanted to stop/)
  })

  it("stays quiet once halted", () => {
    const board = { ...boardWith("a"), nudge: { attempts: 3, halted: true, paused: false } }
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /halted after 3/)
  })

  it("points at an item and names it in the prompt", () => {
    const board = boardWith("a", "b")
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.item?.id, "k1")
    assert.equal(nudgeText(decision.item!), "kanban task k1")
  })
})

describe("things that must not produce a nudge", () => {
  it("an empty board", () => {
    const decision = decideNudge(freshBoard("s"), { now: NOW })
    assert.equal(decision.fire, false)
    assert.equal(decision.reason, "board complete")
  })

  it("a board where everything is done", () => {
    let board = boardWith("a")
    board = updateItem(board, "k1", { status: "done" }, NOW)
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.fire, false)
  })

  it("a paused board", () => {
    const board = { ...boardWith("a"), nudge: pause(freshBoard("s").nudge) }
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.fire, false)
    assert.equal(decision.reason, "paused by user")
  })

  it("a human who is typing", () => {
    const decision = decideNudge(boardWith("a"), { now: NOW, composerBusy: true })
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /you are typing/)
  })

  it("an empty composer box — focused but nothing typed is not busy", () => {
    assert.equal(composerBlocksNudge({ focused: true, input: "" }), false)
    assert.equal(composerBlocksNudge({ focused: true, input: "   " }), false)
    assert.equal(composerBlocksNudge({ focused: true, input: "stop" }), true)
    assert.equal(composerBlocksNudge({ focused: false, input: "stop" }), false)
    assert.equal(composerBlocksNudge(undefined), false)
    // The cross-process flag is the boolean shorthand for the same rule.
    assert.equal(decideNudge(boardWith("a"), { now: NOW, composerBusy: true }).fire, false)
    assert.equal(decideNudge(boardWith("a"), { now: NOW, composerBusy: false }).fire, true)
  })

  it("a board with only done items whose counter is at zero after clearing", () => {
    let board = boardWith("a")
    board = { ...board, nudge: { attempts: 2, halted: true, paused: false } }
    board = updateItem(board, "k1", { status: "done" }, NOW)
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.fire, false)
    assert.equal(decision.nudge.attempts, 0, "a complete board resets the counter")
    assert.equal(decision.nudge.halted, false, "and lifts the halt")
  })
})

describe("progress", () => {
  it("an item reaching done clears the counter and lifts the halt", () => {
    const before = { ...boardWith("a", "b"), nudge: { attempts: 2, halted: true, paused: false } }
    const mutated = updateItem(before, "k1", { status: "done" }, NOW)
    const after = withProgressPolicy(before, mutated)
    assert.equal(after.nudge.attempts, 0)
    assert.equal(after.nudge.halted, false)
  })

  it("a mutation that finishes nothing leaves the counter alone", () => {
    const before = { ...boardWith("a"), nudge: { attempts: 2, halted: false, paused: false } }
    const mutated = updateItem(before, "k1", { title: "renamed" }, NOW)
    const after = withProgressPolicy(before, mutated)
    assert.equal(after.nudge.attempts, 2)
  })

  it("a human restart resumes and zeroes the counter", () => {
    const halted = { attempts: 3, halted: true, paused: true }
    assert.deepEqual(resume(halted), { attempts: 0, halted: false, paused: false, lastResult: "resumed by user" })
  })

  it("pause and unpause are reversible and independent of the counter", () => {
    const base = { attempts: 2, halted: false, paused: false }
    assert.equal(pause(base).paused, true)
    assert.equal(unpause(base).paused, false)
    assert.equal(unpause(base).attempts, 2, "unpause keeps the counter")
    assert.equal(pause(base).attempts, 2, "pause keeps the counter")
  })

  it("noteProgress is idempotent", () => {
    assert.deepEqual(noteProgress(noteProgress({ attempts: 2, halted: true, paused: true })), {
      attempts: 0,
      halted: false,
      paused: true,
    })
  })
})

describe("custom attempt budget", () => {
  it("honours a maxAttempts of 1", () => {
    let board = boardWith("a")
    board = step(board, { maxAttempts: 1 }).board
    assert.equal(board.nudge.halted, true, "one try, then stop")
    assert.equal(step(board, { maxAttempts: 1 }).decision.fire, false)
  })

  it("honours a maxAttempts of 5", () => {
    let board = boardWith("a")
    let fired = 0
    for (let i = 0; i < 7; i += 1) {
      const result = step(board, { maxAttempts: 5 })
      board = result.board
      if (result.decision.fire) fired += 1
    }
    assert.equal(fired, 5)
  })

  it("the default is 3", () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 3)
  })
})

describe("labels", () => {
  it("reads as idle, nudge N, halted N, or paused", () => {
    assert.equal(nudgeLabel({ attempts: 0, halted: false, paused: false }), "idle")
    assert.equal(nudgeLabel({ attempts: 1, halted: false, paused: false }), "nudge 1/3")
    assert.equal(nudgeLabel({ attempts: 2, halted: false, paused: false }), "nudge 2/3")
    assert.equal(nudgeLabel({ attempts: 3, halted: true, paused: false }), "halted 3/3")
    assert.equal(nudgeLabel({ attempts: 1, halted: false, paused: true }), "paused")
  })

  it("honours a custom budget in the label", () => {
    assert.equal(nudgeLabel({ attempts: 2, halted: true, paused: false }, 5), "halted 2/5")
  })
})