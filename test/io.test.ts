/**
 * Export, import and the template, against a real filesystem.
 *
 * The markdown tests prove the format round-trips in memory. These prove the
 * other half: that the file lands where a person would look for it, that a path
 * cannot escape the project, and that what was exported can actually be handed
 * back to `import` and come back as the same tree.
 *
 * The confinement tests are the important ones. The agent picks these paths, and
 * an agent can be talked into `../../.ssh/authorized_keys` by anything it reads.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { apply, confinePath, looksAbsolute, type Store } from "../src/actions.ts"
import type { Files } from "../src/actions.ts"
import { expandHome, projectFiles, resolveInside } from "../src/files.ts"
import { renderTasks, TEMPLATE } from "../src/markdown.ts"
import { treeRows } from "../src/board.ts"
import { freshBoard } from "../src/types.ts"
import { splitArgs } from "../src/addargs.ts"

/** The import handler's own argument rule, mirrored so it can be tested. */
function parseImport(input: string): { path: string | undefined; replace: boolean } {
  let rest = input.trim()
  const replace = /^replace\b/i.test(rest)
  if (replace) rest = rest.replace(/^replace\b/i, "").trim()
  return { path: rest.replace(/^["']/, "").replace(/["']$/, "").trim() || undefined, replace }
}

const NOW = 1_700_000_000_000

/** A store backed by a real temp directory, so files really move. */
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "kanban-io-"))
  let saved = new Map<string, unknown>()
  const store: Store = {
    read: async (sessionID) => (saved.get(sessionID) as never) ?? freshBoard(sessionID),
    write: async (board) => void saved.set(board.sessionID, board),
    files: projectFiles(root),
  }
  const files: Files = projectFiles(root)
  return { root, store, sessionID: "ses_io", files }
}

describe("export", () => {
  it("writes an indented checklist to .ai/tasks.md", async () => {
    const { root, store, sessionID } = await workspace()
    await apply(store, sessionID, { op: "add", title: "Phase 1" }, NOW)
    const { board } = await apply(store, sessionID, { op: "subtask", title: "A task", parentID: "k1" }, NOW)
    const { message } = await apply(store, sessionID, { op: "export" }, NOW)

    assert.match(message, /\.ai\/tasks\.md/)
    const written = await readFile(path.join(root, ".ai/tasks.md"), "utf8")
    assert.match(written, /^- \[ \] Phase 1$/m)
    assert.match(written, /^ {2}- \[ \] A task$/m, "indentation is what makes it a tree again")
    assert.ok(written.includes(renderTasks(board, new Date(NOW)).split("\n")[0]))
  })

  it("does not touch the board file when it exports", async () => {
    const { store, sessionID } = await workspace()
    await apply(store, sessionID, { op: "add", title: "Only task" }, NOW)
    const before = await store.read(sessionID)
    await apply(store, sessionID, { op: "export" }, NOW)
    assert.deepEqual(await store.read(sessionID), before, "exporting is not a mutation")
  })
})

describe("import", () => {
  it("rebuilds the tree from the file export just wrote", async () => {
    const { store, sessionID } = await workspace()
    await apply(store, sessionID, { op: "folder", title: "Phase 1" }, NOW)
    await apply(store, sessionID, { op: "subtasks", parentID: "k1", items: [{ title: "one" }, { title: "two" }] }, NOW)
    await apply(store, sessionID, { op: "add", title: "loose task" }, NOW)
    const before = await store.read(sessionID)

    await apply(store, sessionID, { op: "export" }, NOW)
    await apply(store, sessionID, { op: "clear" }, NOW)
    assert.equal((await store.read(sessionID)).items.length, 0)

    const { message } = await apply(store, sessionID, { op: "import", merge: false }, NOW)
    assert.match(message, /imported 4 task\(s\)/)

    const after = await store.read(sessionID)
    assert.deepEqual(
      treeRows(after).map(({ item, depth }) => [item.id, item.title, depth]),
      treeRows(before).map(({ item, depth }) => [item.id, item.title, depth]),
      "ids, titles and depth all come back",
    )
  })

  it("accepts text directly, with no file involved", async () => {
    const { store, sessionID } = await workspace()
    const { message } = await apply(
      store,
      sessionID,
      { op: "import", content: "- [ ] Root\n  - [ ] Child\n    - [x] Deep" },
      NOW,
    )
    assert.match(message, /imported 3 task\(s\)/)
    const board = await store.read(sessionID)
    assert.equal(board.items[1]?.parentID, "k1", "indentation is read as nesting")
    assert.equal(board.items[2]?.status, "done", "a ticked box comes back ticked")
  })

  it("turns any item with children into a container", async () => {
    const { store, sessionID } = await workspace()
    // A ticked item with children: a folder cannot be ticked by hand, so the
    // file must not be able to make one that says it is already finished.
    await apply(store, sessionID, { op: "import", content: "- [x] Phase\n  - [ ] work" }, NOW)
    const board = await store.read(sessionID)
    assert.equal(board.items[0]?.status, "pending", "a container's own box is derived, never imported")
  })

  it("merges by default and replaces only when asked", async () => {
    const { store, sessionID } = await workspace()
    await apply(store, sessionID, { op: "add", title: "already here" }, NOW)
    await apply(store, sessionID, { op: "import", content: "- [ ] new one" }, NOW)
    assert.equal((await store.read(sessionID)).items.length, 2, "merge keeps what is there")

    await apply(store, sessionID, { op: "import", content: "- [ ] new one", merge: false }, NOW)
    assert.equal((await store.read(sessionID)).items.length, 1, "replace is the restore path")
  })

  it("says which file it could not read, and suggests the content route", async () => {
    const { store, sessionID } = await workspace()
    await assert.rejects(
      apply(store, sessionID, { op: "import", path: ".ai/nope.md" }, NOW),
      /no readable file at \.ai\/nope\.md.*pass the file's content instead/s,
    )
  })

  it("refuses a file with no tasks rather than silently emptying the board", async () => {
    const { store, sessionID } = await workspace()
    await apply(store, sessionID, { op: "add", title: "keep me" }, NOW)
    await assert.rejects(apply(store, sessionID, { op: "import", content: "# just a heading" }, NOW), /no tasks found/)
    assert.equal((await store.read(sessionID)).items.length, 1, "the board is untouched")
  })
})

describe("template", () => {
  it("writes a three-deep example that imports back identically", async () => {
    const { root, store, sessionID } = await workspace()
    const { message } = await apply(store, sessionID, { op: "template" }, NOW)
    assert.match(message, /tasks\.template\.md/)

    const written = await readFile(path.join(root, ".ai/tasks.template.md"), "utf8")
    assert.equal(written, TEMPLATE, "the file is the constant, not a rendering of it")

    const { message: imported } = await apply(store, sessionID, { op: "import", content: written }, NOW)
    assert.match(imported, /imported \d+ task\(s\)/)
    const board = await store.read(sessionID)
    assert.equal(board.items[0]?.parentID, undefined)
    assert.ok(board.items.some((item) => item.parentID), "the template nests, so it teaches nesting")
  })
})

describe("paths stay inside the project", () => {
  it("refuses an absolute path", () => {
    assert.throws(() => confinePath("/etc/passwd"), /must be relative/)
  })

  it("refuses anything that climbs out", () => {
    for (const escape of ["../secrets", "a/../../b", "../../.ssh/authorized_keys"]) {
      assert.throws(() => confinePath(escape), /leaves the project root/, `${escape} must be refused`)
    }
  })

  it("allows a normal nested path, and normalises it", () => {
    assert.equal(confinePath(".ai/tasks.md"), ".ai/tasks.md")
    assert.equal(confinePath("a/b/../c.md"), "a/c.md")
  })

  it("does not let a sibling directory sharing a name prefix through", () => {
    // `/proj` vs `/project`: a naive `startsWith("/proj")` check would let the
    // second one in. This is why the real check is prefix-plus-separator.
    assert.throws(() => resolveInside("/tmp/proj", "../project/secrets"), /leaves the project root/)
  })

  it("refuses to read or write outside the root at the filesystem boundary", async () => {
    const { root } = await workspace()
    const files = projectFiles(root)
    await assert.rejects(files.read("../escape.txt"), /leaves the project root/)
    await assert.rejects(files.write("../escape.txt", "x"), /leaves the project root/)
  })

  it("writes into a directory that does not exist yet", async () => {
    const { root } = await workspace()
    const files = projectFiles(root)
    await files.write("deeply/nested/new/file.md", "ok")
    assert.equal(await readFile(path.join(root, "deeply/nested/new/file.md"), "utf8"), "ok")
  })
})

describe("a store without file access says so plainly", () => {
  it("export refuses rather than pretending", async () => {
    const bare: Store = { read: async (id) => freshBoard(id), write: async () => {} }
    await assert.rejects(apply(bare, "s", { op: "export" }, NOW), /needs file access/)
  })
})
describe("a human naming a path the agent may not", () => {
  // `/ock import ~/other-repo/tasks.md` is a person saying which file they mean.
  // The same string from the agent's tool call is refused. Writing outside the
  // project stays refused for both — that is the direction with consequences.
  it("reads an absolute path when a human asked for it", async () => {
    const { root, store, sessionID, files } = await workspace()
    await files.write("elsewhere.md", "- [ ] from elsewhere")  // written relatively, then named absolutely below
    const filesHuman = projectFiles(root, { allowAbsoluteRead: true })
    const humanStore: Store = { ...store, files: filesHuman }
    const { message } = await apply(humanStore, sessionID, {
      op: "import",
      path: path.join(root, "elsewhere.md"),
      fromHuman: true,
    }, NOW)
    assert.match(message, /imported 1 task/)
    assert.equal((await store.read(sessionID)).items[0]?.title, "from elsewhere")
  })

  it("refuses the same path when the agent asked for it", async () => {
    const { root, store, sessionID, files } = await workspace()
    await files.write("elsewhere.md", "- [ ] should not land")
    await assert.rejects(
      apply(store, sessionID, { op: "import", path: path.join(root, "elsewhere.md") }, NOW),
      /must be relative to the project root/,
    )
    assert.equal((await store.read(sessionID)).items.length, 0, "and the board is untouched")
  })

  it("still refuses to WRITE outside the project, even for a human", async () => {
    const { root } = await workspace()
    await assert.rejects(projectFiles(root, { allowAbsoluteRead: true }).write("/tmp/escape.md", "x"), /must be relative/)
    void root
  })

  it("recognises a Windows path on a Linux host instead of walking past it", () => {
    // `path.isAbsolute("C:\\Users\\me\\tasks.md")` is false here, and a backslash
    // is an ordinary filename character — so without this the traversal check
    // treats it as relative and the path is never examined.
    assert.equal(looksAbsolute("C:\\Users\\me\\tasks.md"), true)
    assert.equal(looksAbsolute("\\\\server\\share\\tasks.md"), true, "a UNC path")
    assert.equal(looksAbsolute("/etc/passwd"), true)
    assert.equal(looksAbsolute("~/tasks.md"), true)
    assert.equal(looksAbsolute(".ai/tasks.md"), false)
    assert.equal(looksAbsolute("a/../b.md"), false)
  })

  it("expands ~ to the home directory", () => {
    assert.equal(expandHome("~/tasks.md", "/home/someone"), path.join("/home/someone", "tasks.md"))
    assert.equal(expandHome("~", "/home/someone"), "/home/someone")
    assert.equal(expandHome(".ai/tasks.md", "/home/someone"), ".ai/tasks.md", "an ordinary path is untouched")
  })

  it("keeps a path with spaces intact, quoted or not", () => {
    // The whole remainder after an optional `replace` is the path. Splitting on
    // whitespace silently imported `~/my` out of `~/my tasks/tasks.md`.
    assert.deepEqual(parseImport("replace ~/my tasks/tasks.md"), { path: "~/my tasks/tasks.md", replace: true })
    assert.deepEqual(parseImport('"~/my tasks.md"'), { path: "~/my tasks.md", replace: false })
    assert.deepEqual(parseImport("   "), { path: undefined, replace: false })
    assert.deepEqual(parseImport("replace"), { path: undefined, replace: true })
  })

  it("splits quoted arguments for the other verbs that take words", () => {
    assert.deepEqual(splitArgs('"~/my tasks.md" k2'), ["~/my tasks.md", "k2"])
    assert.deepEqual(splitArgs("k5 k6 0"), ["k5", "k6", "0"])
    assert.deepEqual(splitArgs("  "), [])
  })
})
