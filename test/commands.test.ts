import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { COMMANDS, HALT_HINT, OP_COMMANDS, REQUIRED_OPS } from "../src/commands.ts"

const tuiSource = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")

describe("the command manifest", () => {
  it("has no duplicate names or slash commands", () => {
    const names = COMMANDS.map((command) => command.name)
    const slash = COMMANDS.map((command) => command.slashName)
    assert.equal(new Set(names).size, names.length, `duplicate command name in ${names.join(", ")}`)
    // Slash collisions with another plugin are the failure mode that makes a
    // command silently vanish, so they get their own assertion.
    assert.equal(new Set(slash).size, slash.length, `duplicate slash name in ${slash.join(", ")}`)
  })

  it("keeps every slash command inside the plugin's own namespace", () => {
    for (const command of COMMANDS) {
      assert.ok(
        command.slashName === "kanban" || command.slashName.startsWith("kanban-"),
        `/${command.slashName} should be namespaced to the plugin`,
      )
      assert.ok(command.name.startsWith("kanban."), `${command.name} should be namespaced`)
    }
  })

  it("gives every command a title and a hint", () => {
    for (const command of COMMANDS) {
      assert.ok(command.title.startsWith("Kanban:"), `${command.name} title should say which plugin it is`)
      assert.ok(command.hint.length > 10, `${command.name} needs a hint a human can act on`)
    }
  })

  it("offers both stop and continue, because the nudge has two directions", () => {
    const slash = COMMANDS.map((command) => command.slashName)
    assert.ok(slash.includes("kanban-stop"), "there must be a way to stop nudging")
    assert.ok(slash.includes("kanban-continue"), "and a way to start it again after a halt")
  })
})

describe("every board operation is reachable by a human", () => {
  const slash = new Set(COMMANDS.map((command) => command.slashName))

  it("every op maps to a slash command that exists", () => {
    for (const op of REQUIRED_OPS) {
      const command = OP_COMMANDS[op]
      assert.ok(command, `op ${op} has no user-facing command`)
      assert.ok(slash.has(command), `op ${op} points at /${command}, which is not a command`)
    }
  })

  it("covers the operations the agent's tool can perform", () => {
    // If the tool grows an op and this list does not, the capability exists
    // only for the model — which is exactly the gap this asserts against.
    const server = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    for (const op of REQUIRED_OPS) {
      assert.ok(server.includes(`"${op}"`), `the agent tool should accept ${op}`)
    }
  })

  it("has a handler for every command the ops point at", () => {
    const handlers = tuiSource.slice(tuiSource.indexOf("const handlers"), tuiSource.indexOf("api.keymap.registerLayer"))
    for (const op of REQUIRED_OPS) {
      const name = COMMANDS.find((command) => command.slashName === OP_COMMANDS[op])?.name
      assert.ok(name, `op ${op} resolves to no command name`)
      assert.ok(handlers.includes(`"${name}"`), `/${OP_COMMANDS[op]} has no handler in tui.tsx`)
    }
  })
})

describe("manifest and renderer agree", () => {
  it("every command has a handler in tui.tsx", () => {
    const handlers = tuiSource.slice(tuiSource.indexOf("const handlers"), tuiSource.indexOf("api.keymap.registerLayer"))
    for (const command of COMMANDS) {
      assert.ok(
        handlers.includes(`"${command.name}"`),
        `command ${command.name} has no handler — a /${command.slashName} with no handler would be a no-op`,
      )
    }
  })

  it("tui.tsx builds its layer from the manifest rather than a second list", () => {
    assert.match(tuiSource, /COMMANDS\.map\(/)
    // A hardcoded list here would drift from the manifest silently.
    const layer = tuiSource.slice(tuiSource.indexOf("api.keymap.registerLayer"))
    assert.doesNotMatch(layer, /slashName: "kanban/)
  })

  it("the halt hint names a command that exists", () => {
    const slash = COMMANDS.map((command) => `/${command.slashName}`)
    const mentioned = HALT_HINT.match(/\/kanban-[\w-]+/g) ?? []
    assert.ok(mentioned.length > 0, "the hint should point at a command")
    for (const reference of mentioned) {
      assert.ok(slash.includes(reference), `${HALT_HINT} points at ${reference}, which is not a command`)
    }
  })
})

describe("storage location", () => {
  it("writes where the docs say it does", async () => {
    const store = await import("../src/store.ts")
    assert.equal(store.STATE_FILE, "kanban.json")
    assert.equal(store.STATE_DIR, ".opencode")
    assert.equal(store.statePath("/tmp/x"), path.join("/tmp/x", ".opencode", "kanban.json"))
  })
})