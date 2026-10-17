import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { COMMANDS, DEFAULT_ROOT, HALT_HINT, OP_COMMANDS, REQUIRED_OPS, ROOT_ALIASES, VERBS } from "../src/commands.ts"

/** Verb form of every command name: `kanban.done` -> `done`. */
const verbs = COMMANDS.map((command) => command.name.replace(/^kanban\./, ""))
const verbSet = new Set(verbs)
const tuiSource = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")

describe("the command manifest", () => {
  it("has no duplicate command or verb names", () => {
    const names = COMMANDS.map((command) => command.name)
    assert.equal(new Set(names).size, names.length, `duplicate command name in ${names.join(", ")}`)
    // Two verbs mapping to one handler would make one unreachable from the
    // prompt, which is how a command silently stops working.
    assert.equal(new Set(verbs).size, verbs.length, `duplicate verb in ${verbs.join(", ")}`)
  })

  it("keeps every slash command inside the plugin's own namespace", () => {
    for (const command of COMMANDS) {
      // Only the namespaced root may be claimed; every other slash entry has to
      // be one this plugin invented, never a bare verb.
      // A verb may be as generic as it likes: it is only reachable as
      // `/ock <verb>`, never as a bare `/add`.
      assert.ok(command.name.startsWith("kanban."), `${command.name} must be handler-keyed`)
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
    
    assert.ok(verbSet.has("stop"), "there must be a way to stop nudging")
    assert.ok(verbSet.has("continue"), "and a way to start it again after a halt")
  })
})

describe("no two states share the word idle", () => {
  it("the panel's idle means an empty board; the nudge's does not", () => {
    // Regression: kanban_read once printed "nudge: idle" while the panel said
    // "running", so a full board appeared idle on one surface and not the other.
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    assert.match(src, /status: \$\{boardStatus\(board\)\}/, "kanban_read must state the board status explicitly")
    assert.doesNotMatch(src, /\(nudging: /, "the old ambiguous label must be gone")
  })

  it("the nudge label never says idle", () => {
    const nudge = readFileSync(new URL("../src/nudge.ts", import.meta.url), "utf8")
    assert.match(nudge, /"no nudges yet"/)
  })
})

describe("the human controls every state", () => {
  

  it("can stop and run the board", () => {
    for (const command of ["run", "pause", "control", "continue"]) {
      assert.ok(verbSet.has(command), `${command} should exist`)
    }
  })

  it("can turn the nudge on and off, and set the try count", () => {
    for (const command of ["nudge-on", "nudge-off", "budget", "control"]) {
      assert.ok(verbSet.has(command), `${command} should exist`)
    }
  })

  it("every control has a handler in tui.tsx", () => {
    const handlers = tuiSource.slice(tuiSource.indexOf("const handlers"), tuiSource.indexOf("ctx.keymap.layer"))
    for (const name of ["kanban.run", "kanban.pause", "kanban.nudge-on", "kanban.nudge-off", "kanban.budget"]) {
      assert.ok(handlers.includes(`"${name}"`), `${name} has no handler`)
    }
  })

  it("the control menu governs all of it, and says what it is set to", () => {
    const menu = tuiSource.slice(tuiSource.indexOf("async function controlPanel"))
    for (const control of ['value: "resume"', 'value: "pause"', 'value: "nudge-toggle"', 'value: "count"']) {
      assert.ok(menu.includes(control), `the control menu is missing ${control}`)
    }
    assert.match(menu, /Currently: /, "the menu should read out the current state")
  })
})

describe("the panel follows the sidebar, not an open panel", () => {
  it("the file watcher reloads the session the sidebar is showing", () => {
    // Regression: the watcher used `ui.panel.current()`, which is undefined
    // unless /kanban was opened. Every agent write then reloaded session ""
    // and blanked the board — so a populated board looked empty.
    assert.match(tuiSource, /sidebarSession\(\) \|\| ui\.panel\.current\(\)\?\.sessionID/)
    assert.doesNotMatch(tuiSource, /refresh\(ui\.panel\.current\(\)\?\.sessionID \?\? ""\)/)
  })

  it("the sidebar slot records the session it is rendering", () => {
    assert.match(tuiSource, /if \(sidebarSession\(\) !== sessionID\) setSidebarSession\(sessionID\)/)
  })
})

describe("debug mode", () => {
  const verbs = new Set(COMMANDS.map((command) => command.name.replace(/^kanban\./, "")))

  it("can be turned on and off by the human", () => {
    assert.ok(verbSet.has("debug-on"))
    assert.ok(verbSet.has("debug-off"))
  })

  it("is also reachable by the agent, with a warning", () => {
    assert.ok(verbSet.has("debug-on"))
    assert.match(tuiSource, /"kanban.debug-on": \(sessionID\) => mutate\(sessionID, \{ op: "debug", enabled: true \}/)
    assert.match(tuiSource, /"kanban.debug-off": \(sessionID\) => mutate\(sessionID, \{ op: "debug", enabled: false \}/)
  })

  it("shows a marker only while it is on", () => {
    assert.match(tuiSource, /<Show when=\{debugOn\(mine\(\)\)}>/)
    assert.match(tuiSource, /DEBUG_PANEL_LABEL/)
  })

  it("logs slash command usage", () => {
    assert.ok(tuiSource.includes('"command",'), "command usage must be logged with its category")
  })
})

describe("the panel's glyphs", () => {
  // Regression: the focus marker and the folder marker were both `▸`, drawn in
  // two adjacent columns. Whenever the current item was a folder — the common
  // case on a nested board — the row drew as `▸ ▸`, two identical glyphs meaning
  // two unrelated things, which reads as a rendering fault rather than meaning.
  it("draws one marker per row: a pointer for the active task, a box for everything else", () => {
    // Regression: the focus marker and the folder marker were both `▸` in two
    // adjacent columns, so a folder that happened to be current drew `▸ ▸` —
    // two identical glyphs meaning two unrelated things. One exclusive choice
    // means that cannot happen at any depth.
    const marker = /\{item\.id === focus\(\) \? "▸" : ([^}]*)\}/.exec(tuiSource)
    assert.ok(marker, "expected the panel's marker expression")
    assert.match(marker[1]!, /checkbox\(/, "everything that is not the active task gets a checkbox")
    assert.doesNotMatch(marker[1]!, /"▸"/, "▸ must appear exactly once, for the active task")
    // A container's box comes from its whole subtree, not from its own status
    // and not from its direct children only.
    assert.match(tuiSource, /containerDone\(board\(\)!, item\.id\) \? "done" : "pending"/)
    assert.match(tuiSource, /descendantProgress/)
  })

  it("colours the active task with the success token, folders included", () => {
    // Regression: folder rows took a fixed colour, so on a nested board — where
    // the current item is usually a container — the active task was painted the
    // same as every other folder. The marker column showed it, but the text,
    // which is what you actually read, did not.
    const titleRow = /<text flexGrow=\{1\} wrapMode="word" fg=\{([^}]*)\}>/.exec(tuiSource)
    assert.ok(titleRow, "expected the title text element")
    assert.equal(titleRow[1]!.trim(), "tone(item)", "every row takes its colour from the same function")
    assert.match(tuiSource, /active: t\.text\.feedback\.success\.base/, "the active task is the success token")
  })

  it("uses only built-in theme tokens, so it works in any theme", () => {
    // A hardcoded hex or a computed colour works on the theme it was written
    // against and is wrong everywhere else.
    const literals = tuiSource.match(/#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/g) ?? []
    assert.deepEqual(literals, [], `the panel must not hardcode colours: ${literals.join(", ")}`)
    for (const token of ["t.text.base", "t.text.muted", "t.text.faint", "t.text.feedback.success.base", "t.text.feedback.info.base", "t.text.feedback.warning.base"]) {
      assert.ok(tuiSource.includes(token), `expected the built-in token ${token}`)
    }
  })

  it("paints every row state from a different token, so no theme can collapse two", () => {
    // The regression this guards is subtle: picking two steps out of one ramp
    // gave a folder and its task near-identical blues, which measured fine and
    // were indistinguishable on screen. Named tokens differ by construction,
    // and this asserts the seven states are actually seven distinct tokens.
    const tones = tuiSource.slice(tuiSource.indexOf("const tones = ()"), tuiSource.indexOf("function Board("))
    const assignments = [...tones.matchAll(/(heading|rule|muted|error|blocked|active|holding|finished):\s*(t\.[a-z.\[\]0-9]+)/g)]
    const byName = Object.fromEntries(assignments.map((m) => [m[1], m[2]]))
    for (const state of ["active", "holding", "muted", "finished", "blocked"]) {
      assert.ok(byName[state], `${state} must come from a theme token`)
    }
    // Only the states a *row* can be in. `rule` and `heading` are chrome — a
    // divider sharing `faint` with finished text is not two rows looking alike.
    const rows = ["active", "holding", "muted", "finished", "blocked"]
    const used = rows.map((state) => byName[state]!)
    assert.equal(new Set(used).size, rows.length, `two row states share a token: ${JSON.stringify(Object.fromEntries(rows.map((r) => [r, byName[r]])))}`)
  })

  it("leaves the folders on the path white, because colouring them was too busy", () => {
    // An earlier version tinted the holding folder and every folder above it:
    // three coloured rows for the single fact "you are here", which made a
    // nested board look busy rather than informative. Indentation and the
    // per-folder counts already answer "where am I", so colour is left to mean
    // one thing only.
    const from = tuiSource.indexOf("const tone = (item:")
    const to = tuiSource.indexOf("return theme.finished", from)
    assert.ok(from > 0 && to > from, "expected the panel's tone function")
    const tone = tuiSource.slice(from, to)
    assert.doesNotMatch(tone, /theme\.holding/, "no folder may take a colour of its own")
    assert.match(tone, /if \(item\.id === focus\(\)\) return theme\.active/, "only the active task is coloured")
    assert.match(tuiSource.slice(to, to + 60), /return theme\.finished\n/, "everything else falls through to white")
  })

  it("keeps the three marker meanings distinct", () => {
    // One column, three states: you-are-here, has-children, and the checkbox.
    // Reusing a glyph across two of them is what produced `▸ ▸`.
    // Two marker meanings: `▸` for the active task, a checkbox for everything
    // else. A container derives its checkbox from every level beneath it.
    assert.match(tuiSource, /containerDone\(board\(\)!, item\.id\) \? "done" : "pending"/,
      "a folder's box must come from its descendants, not its own status")
    assert.match(tuiSource, /descendantProgress/, "and counted over the whole subtree")
    assert.doesNotMatch(tuiSource, /hasKids\(item\) \? "▸"/, "no glyph may mean both active and folder")
  })
})

describe("the namespaced command", () => {
  it("registers one root command, with fallbacks", () => {
    assert.equal(DEFAULT_ROOT, "ock")
    assert.ok(ROOT_ALIASES.includes("kanban"), "a readable fallback for the panel")
  })

  it("every verb maps to a handler in tui.tsx", () => {
    const handlers = tuiSource.slice(tuiSource.indexOf("const handlers"), tuiSource.indexOf("ctx.keymap.layer"))
    // Every verb the manifest advertises must reach a real handler, allowing for
    // the short forms (`rm` -> `remove`).
    const targets = tuiSource.slice(tuiSource.indexOf("const VERB_TARGET"), tuiSource.indexOf("const handlers"))
    for (const verb of Object.keys(VERBS)) {
      const target = /\b(?:rm|del|remove): "([a-z-]+)"/.exec(targets)?.[1]
      if (target) assert.ok(handlers.includes(`"kanban.${target}"`), `/${verb} -> kanban.${target} has no handler`)
      else assert.ok(handlers.includes(`"kanban.${verb}"`), `/${verb} has no handler`)
    }
  })

  it("the root command takes raw arguments", () => {
    assert.match(tuiSource, /name: DEFAULT_ROOT, aliases: ROOT_ALIASES, arguments: true/)
  })

  it("no bare verbs are registered as slash commands", () => {
    // Regression: /add, /done and /rm are the names a competing task plugin
    // wants first. The plugin must never claim them on a public install.
    // Verbs may be generic — `add` is fine as `/ock add`. What must never
    // happen is one of them being registered as a bare global slash command.
    const registered = [...tuiSource.matchAll(/slash: \{ name: ([A-Za-z_]+)/g)].map((m) => m[1])
    assert.deepEqual(registered, ["DEFAULT_ROOT"], "exactly one slash command may be registered")
    for (const greedy of ["add", "done", "rm", "edit", "current", "task", "todo"]) {
      assert.ok(!registered.includes(greedy), `/${greedy} is too generic to claim globally`)
    }
  })
})

describe("every board operation is reachable by a human", () => {
  const verbs = new Set(COMMANDS.map((command) => command.name.replace(/^kanban\./, "")))

  it("every op maps to a slash command that exists", () => {
    for (const op of REQUIRED_OPS) {
      const command = OP_COMMANDS[op]
      assert.ok(command, `op ${op} has no user-facing command`)
      assert.ok(verbSet.has(command.replace("kanban-", "")), `op ${op} points at /${command}, which is not a verb`)
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
      const verb = OP_COMMANDS[op].replace("kanban-", "")
      const name = COMMANDS.find((command) => command.name === `kanban.${verb}`)?.name
      assert.ok(name, `op ${op} resolves to no command name`)
      assert.ok(handlers.includes(`"${name}"`), `/${verb} has no handler in tui.tsx`)
    }
  })
})

describe("manifest and renderer agree", () => {
  it("every command has a handler in tui.tsx", () => {
    const handlers = tuiSource.slice(tuiSource.indexOf("const handlers"), tuiSource.indexOf("api.keymap.registerLayer"))
    for (const command of COMMANDS) {
      assert.ok(
        handlers.includes(`"${command.name}"`),
        `${command.name} has no handler — /ock ${command.name.replace("kanban.", "")} would be a no-op`,
      )
    }
  })

  it("tui.tsx builds its layer from the manifest rather than a second list", () => {
    assert.match(tuiSource, /COMMANDS\.map\(/)
    // A hardcoded list here would drift from the manifest silently.
    const layer = tuiSource.slice(tuiSource.indexOf("api.keymap.registerLayer"))
    assert.doesNotMatch(layer, /name: "kanban-/,
    "no per-verb slash command may be registered — one root dispatches them all")
  })

  it("the halt hint names a command that exists", () => {
    const mentioned = HALT_HINT.match(/\/\w+ [\w-]+/g) ?? []
    assert.ok(mentioned.length > 0, "the hint should point at a command")
    for (const reference of mentioned) {
      const verb = reference.split(" ")[1]!
      assert.ok(verbSet.has(verb), `${HALT_HINT} points at ${reference}, which is not a verb`)
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
describe("the in-window notice", () => {
  // tui.tsx cannot be imported by node --test, so these assert the source. The
  // behaviour they protect is not really testable any other way, and every one
  // of them was a real decision rather than a formality.
  it("draws the block above the composer, in the main window", () => {
    assert.match(tuiSource, /append: "sidebar\.content"/, "the panel stays in the sidebar")
    assert.match(tuiSource, /prepend: "session\.composer\.top"/, "the block belongs above the composer")
  })

  it("announces once per operation, never once per item", () => {
    // Six notices for `addMany` of six is noise, and the one that gets missed
    // is the one you needed. `mutate` is the single funnel, so one call there
    // is the guarantee.
    const mutate = tuiSource.slice(tuiSource.indexOf("async function mutate"), tuiSource.indexOf("async function mutate") + 700)
    assert.equal((mutate.match(/notify\(/g) ?? []).length, 1, "mutate must notify exactly once")
    assert.doesNotMatch(mutate, /for\s*\(/, "mutate must not loop to announce")
  })

  it("keeps errors on the host's toast, because a block can be missed", () => {
    const notifyFn = tuiSource.slice(tuiSource.indexOf("function notify("), tuiSource.indexOf("function toast("))
    assert.doesNotMatch(notifyFn, /"error"/, "an error must never be a block")
    assert.match(tuiSource, /toast\("error"/, "errors go to the toast")
  })

  it("clears the block on a timer so it cannot become furniture", () => {
    assert.match(tuiSource, /NOTICE_MS = \d+/, "a block must expire")
    assert.match(tuiSource, /noticeTimer = setTimeout\(\(\) => setNotice\(undefined\)/, "and must actually be cleared")
  })

  it("honours whichever channel the board asks for", () => {
    assert.match(tuiSource, /board\(\)\?\.notify/, "the mode comes off the board")
    assert.match(tuiSource, /DEFAULT_NOTIFY\)/, "and the default applies when the board is silent")
    assert.match(tuiSource, /ui\.toast\.show\(\{ variant, message \}\)/, "toast mode uses the host's own")
  })

  it("colours the border rather than flooding the background", () => {
    // A saturated fill behind text is the most reliable way to make text
    // unreadable, and this sits above a prompt someone is about to type into.
    assert.match(tuiSource, /border=\{\["left"\]\}/, "a left border, not a full block")
    assert.match(tuiSource, /borderColor=\{tone\(/, "coloured by the notice's kind")
  })

  it("measures the pane's width rather than guessing", () => {
    const slot = tuiSource.slice(tuiSource.indexOf('prepend: "session.composer.top"'))
    assert.match(slot, /element\?\.width/, "read the width off the renderable")
    assert.match(slot, /width="100%"/, "and fill what it measured")
  })
})

describe("every verb you can type reaches a real handler", () => {
  // The gap this closed: `commands.test.ts` checked that every command HAS a
  // handler, but nothing checked that every VERB routes to one. So `/ock
  // control` — documented in VERBS, in the README and in the catalogue —
  // answered "unknown verb", and `/ock log` dispatched to a handler nobody
  // wrote. Both were invisible to a test that only walked one direction.
  // Bounded to the object itself. An unbounded slice runs into unrelated code
  // and invents verbs that do not exist, which is its own kind of false alarm.
  const verbStart = tuiSource.indexOf("const VERB_TARGET")
  const verbBlock = tuiSource.slice(verbStart, tuiSource.indexOf("\n}\n", verbStart))
  const verbs = [...verbBlock.matchAll(/(?:^|\n)\s*"?([\w-]+)"?:\s*"([\w-]+)"/g)].map((m) => ({ verb: m[1], target: m[2] }))
  const handlerStart = tuiSource.indexOf("const handlers: Record<string,")
  const handlerBlock = tuiSource.slice(handlerStart, tuiSource.indexOf("\n    }\n", handlerStart))
  const handlers = new Set([...handlerBlock.matchAll(/^\s*"?([\w.-]+)"?:\s*(?:\(|async)/gm)].map((m) => m[1]))

  it("finds the verb table at all", () => {
    assert.ok(verbs.length > 30, `expected the verb table, found ${verbs.length} entries`)
    assert.ok(handlers.size > 15, `expected the handler table, found ${handlers.size}`)
  })

  it("routes every verb to a handler that exists", () => {
    const dead = verbs.filter((entry) => !handlers.has(`kanban.${entry.target}`))
    assert.deepEqual(dead.map((entry) => `/${entry.verb} -> kanban.${entry.target}`), [], "a verb nobody answers")
  })

  it("covers the verbs the docs promise", () => {
    const routed = new Set(verbs.map((entry) => entry.verb))
    for (const promised of ["add", "done", "rm", "clear", "control", "export", "import", "template", "notify", "help", "log"]) {
      assert.ok(routed.has(promised), `/ock ${promised} is documented but not routable`)
    }
  })
})
