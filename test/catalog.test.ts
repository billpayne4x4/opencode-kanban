/**
 * The catalogue has to stay true.
 *
 * A reference that lies is worse than no reference: a model trusts it, acts on
 * it, and fails in a way nobody can explain. So these tests do not check that
 * the catalogue is well-written — they check that it describes *this* plugin.
 * Add an op without documenting it, or document one that no longer exists, and
 * the suite fails.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { ENTRIES, GROUPS, publicEntries, agentHelp, humanHelp, writeDescription, READ_ENTRY } from "../src/catalog.ts"
import { COMMANDS, OP_COMMANDS, REQUIRED_OPS, VERBS, DEFAULT_ROOT } from "../src/commands.ts"

describe("the catalogue", () => {
  it("documents every operation the tool accepts", () => {
    // `REQUIRED_OPS` is the contract the board already holds itself to. Every
    // one of them must be explainable, or an operation exists that nobody —
    // human or model — can find.
    const documented = new Set(ENTRIES.map((entry) => entry.op))
    for (const op of REQUIRED_OPS) {
      assert.ok(documented.has(op), `${op} is implemented but nothing explains it`)
    }
  })

  it("documents nothing that does not exist", () => {
    const real = new Set<string>([...REQUIRED_OPS, "composer"])
    for (const entry of ENTRIES) {
      assert.ok(real.has(entry.op), `${entry.op} is documented but not an operation`)
    }
  })

  it("gives every public operation a purpose, an example, and a summary", () => {
    // The purpose is the whole point: a signature can be inferred from the
    // name, "when should I use this" cannot. It is the field a new session
    // actually lacks.
    for (const entry of publicEntries()) {
      assert.ok(entry.summary.length > 8, `${entry.op} has no summary`)
      assert.ok(entry.purpose.length > 20, `${entry.op} does not say what it is for`)
      assert.ok(entry.example.includes(entry.op), `${entry.op} has no example using its own op`)
      for (const arg of entry.args) {
        assert.ok(arg.meaning.length > 5, `${entry.op}.${arg.name} is undocumented`)
      }
    }
  })

  it("hides internal plumbing from the documentation", () => {
    const internal = ENTRIES.filter((entry) => entry.internal)
    assert.ok(internal.length > 0, "internal ops should be marked, so this test is real")
    for (const entry of internal) {
      assert.ok(!agentHelp().includes(entry.op), `${entry.op} is internal but appears in the agent help`)
      assert.ok(!writeDescription().includes(entry.op), `${entry.op} is internal but appears in the tool schema`)
    }
  })

  it("names the same verbs the command manifest registers", () => {
    for (const entry of publicEntries()) {
      if (!entry.verb) continue
      for (const verb of entry.verb.split(" / ")) {
        assert.ok(VERBS[verb] !== undefined, `${entry.op} claims verb "${verb}", which is not a registered verb`)
      }
    }
  })

  it("groups every public operation exactly once", () => {
    const grouped = GROUPS.flatMap((group) => group.entries.map((entry) => entry.op))
    const seen = new Set<string>()
    for (const op of grouped) {
      assert.ok(!seen.has(op), `${op} appears in two groups — it will read as two things`)
      seen.add(op)
    }
    for (const entry of publicEntries()) {
      assert.ok(seen.has(entry.op), `${entry.op} is in no group, so /ock help omits it`)
    }
  })
})

describe("what the agent is handed", () => {
  it("the tool schema lists every operation, with when to use it", () => {
    const description = writeDescription()
    for (const entry of publicEntries()) {
      assert.ok(description.includes(`  ${entry.op}`), `${entry.op} is missing from the kanban_write schema`)
      assert.ok(
        description.includes(entry.purpose),
        `${entry.op} has no "use it when" line, so a model can only guess its purpose`,
      )
    }
  })

  it("the help says how to actually work the board, not just what the ops are", () => {
    const help = agentHelp()
    // The loop, the folder rule, and the counter are the three things that
    // cannot be inferred from a signature and are wrong most often.
    assert.match(help, /The loop/, "a new session needs the read → work → done loop")
    assert.match(help, /CONTAINER/, "folders cannot be ticked, and that has to be stated")
    assert.match(help, /resets the nudge counter/, "the counter is evidence of progress, not a mute button")
    assert.match(help, /human's controls/, "nudge/count/pause are not the agent's to reach for")
  })

  it("leaves no trailing whitespace in the schema text", () => {
    // This block is read by humans debugging prompts, and padEnd makes a mess
    // of it very easily.
    for (const line of writeDescription().split("\n")) {
      assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`)
    }
    for (const line of humanHelp().split("\n")) {
      assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`)
    }
  })

  it("renders argument tables that survive their own pipes", () => {
    // `status` is typed `"pending" | "in_progress" | …`. Those pipes are cell
    // separators, so unescaped they shred the row into four columns — and the
    // table is the bit meant to be scannable.
    for (const line of agentHelp().split("\n")) {
      if (!line.startsWith("| `")) continue
      assert.equal(line.split(/(?<!\\)\|/).length, 5, `row has the wrong number of cells: ${line}`)
    }
  })

  it("documents the read and help tools too, so the surface is complete", () => {
    const help = agentHelp()
    assert.ok(help.includes(READ_ENTRY.summary.slice(0, 30)), "kanban_read is not documented")
    assert.match(help, /## kanban_help/, "the help tool does not document itself")
    for (const entry of publicEntries()) {
      assert.match(help, new RegExp(`## kanban_write: ${entry.op}`), `${entry.op} has no section`)
    }
  })

  it("gives every human operation a slash command in the help", () => {
    const help = humanHelp()
    for (const entry of publicEntries()) {
      if (!entry.verb) continue
      assert.ok(help.includes(`/${entry.verb}`), `${entry.op} documents /${entry.verb}, but the help omits it`)
    }
  })
})

describe("help stays reachable by a human", () => {
  it("/ock help exists as a verb, a command, and a handler", () => {
    assert.ok(VERBS.help, "help is not in the verb list")
    assert.ok(COMMANDS.some((command) => command.name === "kanban.help"), "help is not in the command palette")
    const tuiSource = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")
    assert.match(tuiSource, /"kanban\.help":/, "help has no handler in tui.tsx")
  })

  it("the help names the prefix to type", () => {
    // A human copy-pasting out of the help must get a command that runs.
    assert.match(humanHelp(), new RegExp(`/${DEFAULT_ROOT} help`))
    assert.match(agentHelp(), new RegExp(`/${DEFAULT_ROOT} help`))
  })
})

import { readFileSync } from "node:fs"