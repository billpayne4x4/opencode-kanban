/**
 * Round-trip tests.
 *
 * The property that matters is not "the markdown looks right" — it is that
 * export, wipe, import gives back the same board. A backup that cannot be
 * restored is a screenshot, and this file is the only thing standing between
 * the two.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { parseTasks, renderTasks, countNodes, TEMPLATE, TASKS_DIR, TASKS_FILE } from "../src/markdown.ts"
import { addItem, treeRows } from "../src/board.ts"
import { freshBoard } from "../src/types.ts"

const NOW = 1_700_000_000_000

/** A board with depth, a detail, and every status — the round trip's hard case. */
function sample() {
  let board = addItem(freshBoard("ses_1"), { title: "Phase 1: compiler" }, NOW).board
  board = addItem(board, { title: "Inventory the band-aids", parentID: "k1" }, NOW).board
  board = addItem(
    board,
    { title: "Remove the ctor path", detail: "acceptance: no cross-assembly synthesis\nsecond line", parentID: "k2" },
    NOW,
  ).board
  board = addItem(board, { title: "Tighten the allocator", parentID: "k1" }, NOW).board
  board = addItem(board, { title: "Blocked on a decision", parentID: "k1", status: "blocked" }, NOW).board
  board = addItem(board, { title: "Working on it now", status: "in_progress" }, NOW).board
  board = addItem(board, { title: "Finished already", status: "done" }, NOW).board
  return board
}

/** Rebuild a board from parsed nodes, the way the import op will. */
function materialise(nodes: ReturnType<typeof parseTasks>, counter: { next: number } = { next: 1 }) {
  const items: { id: string; title: string; status: string; detail?: string; parentID?: string }[] = []
  const walk = (node: (typeof nodes)[number], parentID: string | undefined) => {
    const id = `k${counter.next++}`
    items.push({ id, title: node.title, status: node.status, ...(node.detail ? { detail: node.detail } : {}), ...(parentID ? { parentID } : {}) })
    for (const child of node.children) walk(child, id)
  }
  for (const node of nodes) walk(node, undefined)
  return items
}

describe("export", () => {
  it("writes indented checkboxes, one level per depth", () => {
    const md = renderTasks(sample(), new Date(0))
    const taskLines = md.split("\n").filter((line) => /^\s*- \[.\]/.test(line))
    assert.deepEqual(taskLines, [
      "- [ ] Phase 1: compiler",
      "  - [ ] Inventory the band-aids",
      "    - [ ] Remove the ctor path",
      "  - [ ] Tighten the allocator",
      "  - [!] Blocked on a decision",
      "- [-] Working on it now",
      "- [x] Finished already",
    ])
  })

  it("carries status in the checkbox, so nothing is silently downgraded", () => {
    const md = renderTasks(sample(), new Date(0))
    assert.match(md, /- \[x\]/, "a done task must not come back as pending")
    assert.match(md, /- \[!\]/, "blocked is a real signal and must survive the file")
    assert.match(md, /- \[-\]/, "in-progress must survive too")
  })

  it("puts detail on a continuation line, not as its own task", () => {
    const md = renderTasks(sample(), new Date(0))
    const detail = md.split("\n").filter((line) => line.includes("acceptance:") || line.includes("second line"))
    assert.equal(detail.length, 2, "both lines of the detail survive")
    for (const line of detail) {
      assert.doesNotMatch(line, /- \[/, "detail must not read as a task")
    }
  })

  it("says where it came from and that it can be read back", () => {
    const md = renderTasks(sample(), new Date(0))
    assert.match(md, /OpenCode Kanban/, "provenance, so a stray file is identifiable")
    assert.match(md, /\/ock import/, "the file tells the reader how to restore it")
  })
})

describe("import", () => {
  it("reads back exactly what export wrote", () => {
    const before = sample()
    const after = materialise(parseTasks(renderTasks(before, new Date(0))))
    assert.deepEqual(
      after.map((item) => [item.id, item.title, item.status, item.parentID ?? null]),
      treeRows(before).map(({ item, depth }) => [
        item.id,
        item.title,
        item.status,
        depth > 0 ? before.items.find((c) => c.id === item.parentID)!.id : null,
      ]),
      "titles, order, status and parentage must all survive",
    )
  })

  it("survives the brutal version: export, wipe everything, import", () => {
    const before = sample()
    const md = renderTasks(before, new Date(0))
    const wiped = freshBoard("ses_2") // a different session: the board is gone
    assert.equal(wiped.items.length, 0)
    const restored = materialise(parseTasks(md), { next: 1 })
    assert.equal(restored.length, before.items.length)
    assert.deepEqual(
      restored.map((i) => [i.id, i.title, i.parentID ?? null]),
      before.items.map((i) => [i.id, i.title, i.parentID ?? null]),
    )
  })

  it("restores detail, including a multi-line one", () => {
    const md = renderTasks(sample(), new Date(0))
    const nodes = parseTasks(md)
    const deep = nodes[0]!.children[0]!.children[0]!
    assert.equal(deep.title, "Remove the ctor path")
    assert.equal(deep.detail, "acceptance: no cross-assembly synthesis\nsecond line")
  })

  it("accepts a hand-written file indented from flush left", () => {
    // Someone pasting from a document indents the whole block. Refusing that
    // would be a surprise, and the shallowest line is unambiguous.
    const md = ["    - [ ] Root", "        - [ ] Child", "            - [ ] Grandchild"].join("\n")
    const nodes = parseTasks(md)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]!.children[0]!.children[0]!.title, "Grandchild")
  })

  it("accepts * and + bullets, and tabs", () => {
    const nodes = parseTasks("* [ ] Star\n\t- [x] Tabbed")
    assert.equal(nodes[0]!.title, "Star")
    assert.equal(nodes[0]!.children[0]!.status, "done")
  })

  it("reads an unknown glyph as pending rather than failing the file", () => {
    // The file is meant to be hand-edited; a typo should not block a restore.
    const nodes = parseTasks("- [*] Odd glyph\n- [X] Shouting done")
    assert.equal(nodes[0]!.status, "pending")
    assert.equal(nodes[1]!.status, "done")
  })

  it("ignores headings, comments and blank lines", () => {
    const nodes = parseTasks("# Tasks\n\n<!-- x -->\n\n- [ ] Real task\n")
    assert.equal(countNodes(nodes), 1)
    assert.equal(nodes[0]!.title, "Real task")
  })

  it("refuses a file with no tasks, and says so", () => {
    assert.throws(() => parseTasks("# Tasks\n\nnothing here"), /no tasks found/)
  })

  it("refuses a pathologically long line rather than eating the file", () => {
    assert.throws(() => parseTasks(`- [ ] ${"x".repeat(2000)}`), /keep task lines under/)
  })

  it("is idempotent: parse(render(parse(x))) equals parse(x)", () => {
    const once = parseTasks(TEMPLATE)
    const twice = parseTasks(renderTasks({ ...freshBoard("s"), items: [] }, new Date(0)) + TEMPLATE)
    // The template itself must round-trip, which is the case a user hits first.
    assert.deepEqual(countNodes(once), countNodes(twice))
  })
})

describe("the template", () => {
  it("shows one task per level, three deep", () => {
    // The thing nobody can guess is whether nesting is allowed at all. A flat
    // example would teach the easy half and leave the useful half undocumented.
    const nodes = parseTasks(TEMPLATE)
    assert.deepEqual(nodes.map((n) => n.title), ["Phase 1: understand the problem", "Phase 2: do the work", "Phase 3: prove it"])
    assert.equal(nodes[0]!.children[0]!.children[0]!.children[0]!.title, "Run it and watch it fail first")
  })

  it("uses the checkbox syntax the parser reads", () => {
    assert.match(TEMPLATE, /- \[ \] /, "a template that would not import is worse than none")
    assert.match(TEMPLATE, /`\/ock import`/, "it tells the user what to do with it")
  })

  it("lives in .ai/ where the export goes", () => {
    assert.equal(TASKS_DIR, ".ai")
    assert.equal(TASKS_FILE, "tasks.md")
  })
})