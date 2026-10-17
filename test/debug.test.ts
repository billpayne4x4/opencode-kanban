import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { after, describe, it } from "node:test"
import { DEBUG_LOG, debug, debugAlways, debugOn } from "../src/debug.ts"
import { freshBoard } from "../src/types.ts"

describe("the debug switch", () => {
  it("is off unless the board says otherwise", () => {
    assert.equal(debugOn(undefined), false)
    assert.equal(debugOn({}), false)
    assert.equal(debugOn({ debug: false }), false)
    assert.equal(debugOn({ debug: true }), true)
  })
})

describe("the debug log", () => {
  after(async () => {
    // Clear the probe lines so the real log stays readable in normal use.
    const { writeFile } = await import("node:fs/promises")
    await writeFile(DEBUG_LOG, "")
  })

  // The log path is a constant by design (it is printed in the panel), so these
  // tests assert on the real file and clean up after themselves.
  const read = async () => {
    try {
      return await readFile(DEBUG_LOG, "utf8")
    } catch {
      return ""
    }
  }

  it("writes nothing while debug is off", async () => {
    const before = await read()
    const wrote = debug(freshBoard("s"), "tool", "should not appear")
    assert.equal(wrote, false)
    assert.equal(await read(), before)
  })

  it("writes a timestamped, categorised line when on", async () => {
    const board = { ...freshBoard("s"), debug: true }
    assert.equal(debug(board, "nudge", "nudge 1/3 -> firing"), true)
    const text = await read()
    const line = text.trim().split("\n").pop() ?? ""
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[nudge\] nudge 1\/3 -> firing$/)
  })

  it("records every category it is given", async () => {
    const board = { ...freshBoard("s"), debug: true }
    for (const category of ["tool", "event", "nudge", "command", "state", "error"] as const) {
      debug(board, category, `probe ${category}`)
    }
    const text = await read()
    for (const category of ["tool", "event", "nudge", "command", "state", "error"]) {
      assert.match(text, new RegExp(`\\[${category}\\] probe ${category}`))
    }
  })

  it("flattens newlines so one entry stays one line", async () => {
    const board = { ...freshBoard("s"), debug: true }
    debug(board, "tool", "line one\nline two")
    const text = await read()
    assert.match(text, /\[tool\] line one line two/)
    assert.doesNotMatch(text, /line one\nline two/)
  })

  it("logs unconditionally for lifecycle facts", async () => {
    debugAlways("state", "probe unconditional attach")
    assert.match(await read(), /\[state\] probe unconditional attach/)
  })

  it("points at the file it writes to", () => {
    assert.match(DEBUG_LOG, /^\/tmp\//)
  })
})