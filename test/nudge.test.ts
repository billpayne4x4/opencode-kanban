import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { addItem, updateItem } from "../src/board.ts"
import { statusCells } from "../src/format.ts"
import {
  DEFAULT_MAX_ATTEMPTS,
  composerBlocksNudge,
  decideNudge,
  boardStatus,
  isHalted,
  isStopped,
  nudgeBudget,
  nudgeEnabled,
  nudgeIsActive,
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
    // Regression: the trailing count is OPEN TASKS. Labelled a bare "left" it
    // sat next to a 3-nudge budget as "5 left" and read as five nudges
    // remaining — telling an agent it had more room to stall than it had. Both
    // counts now name what they count, and the try count comes from the budget.
    const text = nudgeText(decision.item!, 1, 3, 6)
    assert.match(text, /^kanban k1 \| try 1\/3 \| 6 open \| 2 tries left$/, "the nudge carries compact state")
    assert.match(nudgeText(decision.item!, 3, 3, 6), /0 tries left/, "the last try says so")
    assert.match(nudgeText(decision.item!, 2, 3, 6), /1 try left$/, "singular when one is left")
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
    assert.equal(nudgeLabel({ attempts: 0, halted: false, paused: false }), "no nudges yet")
    assert.equal(nudgeLabel({ attempts: 1, halted: false, paused: false }), "nudge 1/3")
    assert.equal(nudgeLabel({ attempts: 2, halted: false, paused: false }), "nudge 2/3")
    assert.equal(nudgeLabel({ attempts: 3, halted: true, paused: false }), "halted 3/3")
    assert.equal(nudgeLabel({ attempts: 1, halted: false, paused: true }), "paused")
  })

  it("honours a custom budget in the label", () => {
    assert.equal(nudgeLabel({ attempts: 2, halted: true, paused: false }, 5), "halted 2/5")
  })
})

describe("the status line, as labels separated by dots", () => {
  /** Just the labels, so a test can read the row without the separators. */
  const labels = (board: unknown) =>
    statusCells(board as never)
      .filter((cell) => cell.kind === "text")
      .map((cell) => (cell as { value: string }).value)

  it("puts the status first, then the switch and the budget", () => {
    assert.deepEqual(labels(boardWith("a")), ["running", "nudge on", "3 tries"])
    assert.deepEqual(labels(undefined), ["idle", "nudge on", "3 tries"])
  })

  it("separates every pair of labels with exactly one dot", () => {
    const cells = statusCells(boardWith("a"))
    const dots = cells.filter((cell) => cell.kind === "dot").length
    // L labels become L-1 dots between them.
    assert.equal(labels(boardWith("a")).length, 3)
    assert.equal(dots, 2)
    assert.equal(cells.length, 5, "3 labels and 2 dots, interleaved")
    assert.equal(cells[0]?.kind, "text", "the row must start with a label, not a dot")
    assert.equal(cells[cells.length - 1]?.kind, "text", "and end with one")
    for (const [index, cell] of cells.entries()) {
      assert.equal(cell.kind === "dot", index % 2 === 1, "dots must sit on the odd positions")
    }
  })

  const tones = (board: unknown) =>
    new Map(statusCells(board as never).flatMap((c) => (c.kind === "text" ? [[(c as { value: string }).value, (c as { tone: string }).tone] as const] : [])))

  it("counts the tries up as the nudge climbs", () => {
    const base = boardWith("a")
    assert.match(tones(base).get("3 tries") ?? "", /normal/, "before nudging, just the budget")
    for (const [attempts, label] of [[1, "1/3 tries"], [2, "2/3 tries"]] as const) {
      const mid = { ...base, nudge: { ...base.nudge, attempts } }
      assert.ok(tones(mid).has(label), `expected "${label}", got ${[...tones(mid).keys()].join(" / ")}`)
      assert.equal(tones(mid).get("3 tries"), undefined, "the bare budget is replaced while counting")
    }
  })

  it("only reddens the tries once they are actually exhausted", () => {
    const base = boardWith("a")
    // Mid-budget: normal, or the colour would cry wolf on every nudge.
    for (const attempts of [1, 2]) {
      const mid = { ...base, nudge: { ...base.nudge, attempts } }
      assert.equal(tones(mid).get(`${attempts}/3 tries`), "normal", `${attempts}/3 is not exhausted`)
      assert.equal(tones(mid).get("stopped"), undefined)
    }
    // Budget spent and the agent still has not moved: red.
    const spent = { ...base, nudge: { ...base.nudge, attempts: 3, halted: true } }
    assert.equal(tones(spent).get("3/3 tries"), "alert")
  })

  it("reads halted, in red, with the count that explains it", () => {
    const base = boardWith("a")
    const halted = { ...base, nudge: { ...base.nudge, attempts: 3, halted: true } }
    assert.equal(tones(halted).get("halted"), "alert", "the status word turns red")
    assert.equal(tones(halted).get("3/3 tries"), "alert", "and so does the count — it is the explanation")
  })

  it("a halted board says halted, never running", () => {
    const halted = { ...boardWith("a"), nudge: { attempts: 3, halted: true, paused: false } }
    assert.equal(boardStatus(halted), "halted", "reporting running while halted is a lie")
    assert.equal(isHalted(halted), true)
    assert.equal(isHalted(boardWith("a")), false)
  })

  it("a self-stopped board is stopped but not an error", () => {
    const stopped = { ...boardWith("a"), nudge: pause(freshBoard("s").nudge) }
    assert.equal(boardStatus(stopped), "stopped")
    assert.equal(isHalted(stopped), false)
    assert.deepEqual([...tones(stopped).values()].filter((t) => t === "alert"), [])
  })

  it("uses the plural correctly", () => {
    const base = boardWith("a")
    const one = { ...base, nudge: { ...base.nudge, maxAttempts: 1, attempts: 1, halted: true } }
    assert.ok(tones(one).has("halted"))
    const two = { ...base, nudge: { ...base.nudge, maxAttempts: 2, attempts: 1 } }
    assert.ok(tones(two).has("1/2 tries"))
  })

  it("a board you stopped yourself is normal, not red", () => {
    const stopped = { ...boardWith("a"), nudge: pause(freshBoard("s").nudge) }
    assert.equal(tones(stopped).get("stopped"), "normal", "red is reserved for the plugin giving up")
    assert.equal(tones(stopped).get("paused"), "normal")
    // And nothing in the row is red.
    assert.deepEqual([...tones(stopped).values()].filter((t) => t === "alert"), [])
  })

  it("reflects the switch and the budget", () => {
    const base = boardWith("a")
    assert.ok(tones({ ...base, nudge: { ...base.nudge, enabled: false } }).has("nudge off"))
    assert.ok(tones({ ...base, nudge: { ...base.nudge, maxAttempts: 7 } }).has("7 tries"))
  })

  it("never emits an empty label", () => {
    for (const board of [boardWith("a"), undefined, { ...boardWith("a"), nudge: pause(freshBoard("s").nudge) }]) {
      for (const cell of statusCells(board as never)) {
        if (cell.kind === "text") assert.ok(cell.value.length > 0, "a blank cell would collapse the row")
      }
    }
  })
})

describe("board status", () => {
  it("is running when there is open work", () => {
    assert.equal(boardStatus(boardWith("a")), "running")
  })

  it("is idle with nothing queued or everything done", () => {
    assert.equal(boardStatus(freshBoard("s")), "idle")
    const done = updateItem(boardWith("a"), "k1", { status: "done" }, NOW)
    assert.equal(boardStatus(done), "idle")
    assert.equal(boardStatus(undefined), "idle")
  })

  it("is stopped when the human stopped it, even with work waiting", () => {
    const paused = { ...boardWith("a"), nudge: pause(freshBoard("s").nudge) }
    assert.equal(boardStatus(paused), "stopped")
    assert.equal(isStopped(paused), true)
    assert.equal(isStopped(boardWith("a")), false)
  })

  it("a halt says halted, not stopped — the human can tell them apart", () => {
    const halted = { ...boardWith("a"), nudge: { ...freshBoard("s").nudge, attempts: 3, halted: true } }
    // These used to report the same word, so a board that had halted itself was
    // indistinguishable from one the human had deliberately parked — and
    // "stopped" says nothing about whether anything is recoverable.
    assert.equal(boardStatus(halted), "halted")
    // Still distinct states underneath, and still cleared by different commands.
    assert.equal(isStopped(halted), false, "a halt is not a human stop")
    assert.equal(isHalted(halted), true)
  })
})

describe("the nudge switch and budget", () => {
  it("defaults to on, and to three tries", () => {
    assert.equal(nudgeEnabled(undefined), true, "an absent switch means on")
    assert.equal(nudgeEnabled({ attempts: 0, halted: false, paused: false }), true)
    assert.equal(nudgeBudget(undefined), DEFAULT_MAX_ATTEMPTS)
    assert.equal(nudgeBudget({ attempts: 0, halted: false, paused: false }), DEFAULT_MAX_ATTEMPTS)
  })

  it("reads an explicit switch and budget", () => {
    assert.equal(nudgeEnabled({ attempts: 0, halted: false, paused: false, enabled: false }), false)
    assert.equal(nudgeBudget({ attempts: 0, halted: false, paused: false, maxAttempts: 7 }), 7)
  })

  it("ignores a nonsensical budget rather than trusting it", () => {
    const base = { attempts: 0, halted: false, paused: false }
    assert.equal(nudgeBudget({ ...base, maxAttempts: 0 }, 3), 3)
    assert.equal(nudgeBudget({ ...base, maxAttempts: -2 }, 3), 3)
    assert.equal(nudgeBudget({ ...base, maxAttempts: 5.9 }, 3), 5)
  })

  it("never fires while switched off, however idle it gets", () => {
    const board = { ...boardWith("a"), nudge: { attempts: 0, halted: false, paused: false, enabled: false } }
    const decision = decideNudge(board, { now: NOW })
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /switched off/)
  })

  it("the board's own budget beats the configured default", () => {
    const board = { ...boardWith("a"), nudge: { attempts: 0, halted: false, paused: false, maxAttempts: 1 } }
    assert.equal(decideNudge(board, { maxAttempts: 5, now: NOW }).fire, true)
    const after = { ...board, nudge: { ...board.nudge, attempts: 1, halted: true } }
    assert.equal(decideNudge(after, { maxAttempts: 5, now: NOW }).fire, false, "budget of 1 halts after one")
  })

  it("falls back to the configured default when the board sets none", () => {
    let board = boardWith("a")
    let fired = 0
    for (let i = 0; i < 4; i += 1) {
      const result = decideNudge(board, { maxAttempts: 2, now: NOW })
      if (result.fire) fired += 1
      board = { ...board, nudge: result.nudge }
    }
    assert.equal(fired, 2)
  })
})

describe("panel visibility", () => {
  it("says nothing while the policy is idle", () => {
    assert.equal(nudgeIsActive(undefined), false)
    assert.equal(nudgeIsActive({ attempts: 0, halted: false, paused: false }), false)
  })

  it("speaks up once it has nudged, paused or halted", () => {
    assert.equal(nudgeIsActive({ attempts: 1, halted: false, paused: false }), true)
    assert.equal(nudgeIsActive({ attempts: 3, halted: true, paused: false }), true)
    assert.equal(nudgeIsActive({ attempts: 0, halted: false, paused: true }), true)
  })
})