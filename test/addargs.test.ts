import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { parseAdd, parseArgs } from "../src/addargs.ts"

describe("/add <parent> \"title\"", () => {
  it("reads a quoted title at the root", () => {
    assert.deepEqual(parseAdd('"do a thing"'), { title: "do a thing" })
  })

  it("files a subtask when a task id comes first", () => {
    assert.deepEqual(parseAdd('k3 "do a thing"'), { parentID: "k3", title: "do a thing" })
  })

  it("accepts single quotes", () => {
    assert.deepEqual(parseAdd("k7 'a subtask'"), { parentID: "k7", title: "a subtask" })
  })

  it("keeps the title whole, spaces and all", () => {
    assert.deepEqual(parseAdd('k2 "a much longer title with spaces"'), {
      parentID: "k2",
      title: "a much longer title with spaces",
    })
  })

  it("treats a leading non-id word as part of the instruction", () => {
    // "write k3 to a file" must not file it under k3 by accident.
    assert.equal(parseAdd('"write k3 to a file"')?.parentID, undefined)
    assert.equal(parseAdd('write k3 "now"')?.parentID, undefined)
  })

  it("falls back to unquoted input", () => {
    assert.deepEqual(parseAdd("k3 do a thing"), { parentID: "k3", title: "do a thing" })
    assert.deepEqual(parseAdd("just words"), { title: "just words" })
    assert.deepEqual(parseAdd("k4"), { title: "k4" })
  })

  it("returns nothing for empty or unusable input", () => {
    assert.equal(parseAdd(undefined), null)
    assert.equal(parseAdd(""), null)
    assert.equal(parseAdd('""'), null, "an empty title is not a task")
  })
})

describe("argument-taking commands", () => {
  it("splits ids from a quoted title", () => {
    assert.deepEqual(parseArgs('k1 k2 "new title"'), { ids: ["k1", "k2"], title: "new title" })
    assert.deepEqual(parseArgs("k5"), { ids: ["k5"], title: undefined })
  })

  it("takes a bare title when no id is given", () => {
    assert.deepEqual(parseArgs('"just retitle me"'), { ids: [], title: "just retitle me" })
    assert.deepEqual(parseArgs("retitle me"), { ids: [], title: "retitle me" })
  })

  it("is empty for no input", () => {
    assert.deepEqual(parseArgs(undefined), { ids: [] })
    assert.deepEqual(parseArgs("   "), { ids: [] })
  })
})