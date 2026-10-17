/**
 * The night shift.
 *
 * Everything else in this suite is about correctness. This one is about a
 * specific promise: the board can be left running overnight without the plugin
 * stopping the work, and without it firing so often that the transcript is
 * unusable.
 *
 * The failure it guards is not a crash. It is the quiet one — an agent working
 * steadily through a long plan, the counter creeping up anyway, and the plugin
 * announcing it has given up three hours before the work was due to finish.
 * Nobody is awake to notice. That is the whole risk.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { decideNudge, DEFAULT_MAX_ATTEMPTS, noteProgress } from "../src/nudge.ts"
import { addItem, closeCompletedAncestors, updateItem } from "../src/board.ts"
import { withProgressPolicy } from "../src/nudge.ts"
import { freshBoard, type Board } from "../src/types.ts"

const NOW = 1_700_000_000_000
const MINUTE = 60_000

/**
 * One step: the agent finishes a task, then the session goes idle.
 *
 * Mirrors the order `apply()` uses — progress policy first, container cascade
 * second — and the order matters: if the cascade ran first, the folders closing
 * themselves would look like the agent finishing work, and would wipe the tally
 * on a stalled board.
 */
function step(board: Board, id: string, at: number): Board {
  const done = updateItem(board, id, { status: "done" }, at)
  return closeCompletedAncestors(withProgressPolicy(board, done), at)
}

describe("left running overnight", () => {
  function plan(size: number) {
    let board = freshBoard("night")
    board = addItem(board, { title: "Phase 1" }, NOW).board
    const ids: string[] = []
    for (let n = 2; n <= size; n += 1) {
      board = addItem(board, { title: `task ${n}`, parentID: "k1" }, NOW).board
      ids.push(`k${n}`)
    }
    return { board, ids }
  }

  it("never halts while the agent keeps finishing things", () => {
    // The core promise. Each step completes a task — real progress — and then
    // the session idles, which is the trigger. If the tally survived progress,
    // three idle events over a long plan would halt it.
    const { board: start, ids } = plan(9)
    let board = start
    let at = NOW
    let highest = 0
    let nudges = 0

    for (const id of ids) {
      board = step(board, id, at)
      // Idle fires right after each completion, as it does in the host.
      const decision = decideNudge(board, { now: at + MINUTE })
      board = { ...board, nudge: decision.nudge }
      if (decision.fire) nudges += 1
      highest = Math.max(highest, board.nudge.attempts)
      at += 2 * MINUTE
    }

    assert.equal(board.nudge.halted, false, "a steady run must never halt")
    assert.equal(board.items[0]?.status, "done", "and every container closed on its own")
    assert.ok(highest <= 1, `the tally stayed at ${highest}; progress should hold it at 1`)

    // At most one per finished task, and no more. The exact cadence belongs to
    // the host — `session.step.ended` fires per model call, and this simulation
    // fires exactly one idle per task, which is more disciplined than a real
    // turn. The number that matters is the one above: the tally never climbs,
    // so a long plan cannot reach the cap however long it runs.
    assert.ok(nudges <= ids.length, `fired ${nudges} times for ${ids.length} tasks`)
    assert.ok(nudges < ids.length, "a plan that is going forward should not be announced every step")
  })

  it("counts consecutive stalls exactly, and stops at the cap", () => {
    const { board: start } = plan(6)
    let board = start
    const fired: number[] = []
    for (let n = 0; n < 10; n += 1) {
      const decision = decideNudge(board, { now: NOW + n * MINUTE })
      board = { ...board, nudge: decision.nudge }
      if (decision.fire) fired.push(decision.nudge.attempts)
      if (decision.nudge.halted) break
    }
    assert.deepEqual(fired, [1, 2, 3], "three nudges, no more")
    assert.equal(board.nudge.halted, true)
    assert.equal(board.nudge.attempts, DEFAULT_MAX_ATTEMPTS)
  })

  it("stays halted afterwards — a halt waits for a human, it does not drift", () => {
    const { board: start } = plan(6)
    let board = start
    for (let n = 0; n < 4; n += 1) board = { ...board, nudge: decideNudge(board, { now: NOW + n * MINUTE }).nudge }
    for (let n = 4; n < 40; n += 1) {
      const decision = decideNudge(board, { now: NOW + n * MINUTE })
      assert.equal(decision.fire, false, "a halt does not re-arm itself an hour later")
      assert.match(decision.reason, /halted/)
      board = { ...board, nudge: decision.nudge }
    }
    assert.equal(board.nudge.attempts, DEFAULT_MAX_ATTEMPTS, "and the tally does not drift upward")
  })

  it("one burst of completions at the end resets the tally before it can halt", () => {
    // An agent that stalled twice and then does the whole remaining plan in one
    // go must not halt on the next idle, because the stall is over.
    const { board: start, ids } = plan(6)
    let board = start
    for (const id of ids.slice(0, 2)) {
      board = step(board, id, NOW)
      board = { ...board, nudge: decideNudge(board, { now: NOW + MINUTE }).nudge }
    }
    assert.equal(board.nudge.attempts, 1, "one stall so far")
    for (const id of ids.slice(2)) board = step(board, id, NOW + 10 * MINUTE)
    const decision = decideNudge(board, { now: NOW + 11 * MINUTE })
    assert.equal(board.nudge.attempts, 0, "finishing the work wipes the tally")
    assert.equal(decision.fire, false, "and an empty board does not nudge")
    assert.equal(board.items.every((item) => item.status === "done"), true)
  })

  it("a pause outlives everything and stops the firing immediately", () => {
    const { board: start } = plan(4)
    const paused = { ...start, nudge: { ...start.nudge, paused: true } }
    for (let n = 0; n < 20; n += 1) {
      const decision = decideNudge(paused, { now: NOW + n * MINUTE })
      assert.equal(decision.fire, false, "a paused board never fires")
    }
  })

  it("does not fire while the human is typing", () => {
    const { board: start } = plan(4)
    const decision = decideNudge(start, { now: NOW, composerBusy: true })
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /typing/)
  })

  it("a long gap between nudges does not let the tally skip ahead", () => {
    // Eight hours pass with nothing happening. The answer must still be "three
    // nudges then stop", not "three nudges every four hours".
    const { board: start } = plan(6)
    let board = start
    let count = 0
    for (let n = 0; n < 6 && !board.nudge.halted; n += 1) {
      const decision = decideNudge(board, { now: NOW + n * 8 * 60 * MINUTE })
      board = { ...board, nudge: decision.nudge }
      if (decision.fire) count += 1
    }
    assert.equal(count, DEFAULT_MAX_ATTEMPTS, "still exactly the budget")
  })

  it("noteProgress is idempotent, so a double event cannot double-charge", () => {
    const nudge = freshBoard("x").nudge
    const once = noteProgress(nudge)
    const twice = noteProgress(once)
    assert.equal(once.attempts, 0)
    assert.equal(twice.attempts, 0, "resetting twice is still zero, not negative")
    assert.equal(twice.halted, false, "and a progress signal lifts a halt")
  })
})