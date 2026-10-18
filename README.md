<div align="center">
  <img src="logo.svg" alt="OpenCode Kanban logo" width="120" />
  <h1>OpenCode Kanban</h1>
  <p><strong>A task board for OpenCode that the agent can read and write — which restarts a stalled agent, three times, then assumes you meant to stop it.</strong></p>
</div>

---

## 🎯 The problem it solves

Two things go wrong with agent task tracking, and this plugin exists for both.

**The agent forgets.** You write a plan, the agent follows half of it, the
context compacts, and the plan lives nowhere you can read. A board in your head
does not survive compaction. A board in a chat transcript is unreadable by the
next session.

**The agent stalls, and you cannot tell why.** An agent that goes quiet with work
outstanding has two possible causes:

- it stopped and needs a `continue`
- *you* stopped it on purpose

From the outside these are identical. Restarting a paused agent is helpful.
Restarting an agent you deliberately stopped is the single most annoying thing a
tool can do.

So the plugin takes the cheap, recoverable action a **bounded number of times**,
then assumes the human meant it and says so out loud. Being wrong costs three
short prompts. Not stopping costs ignoring a stop button forever.

> **Three nudges. Then it halts, tells you, and waits for `/ock continue`.**

---

## 📸 The panel

```text
OpenCode Kanban (3/9)
─────────────────────
▸ [ ] Wire export / import to both surfaces   1/9
    ✓ [x] MUTATION_SCHEMA + op enum
    ▸ [x] REQUIRED_OPS + OP_COMMANDS
      · [ ] catalog.ts entries
    · [ ] /ock export, import, template handlers
· [ ] README for all of it
─────────────────────
running   ·   nudge on   ·   2/3 tries
```

**Indentation is the tree.** One step per level, depth-first, so a four-level
board reads as four levels instead of a flat list. Nesting has no depth limit.

**Folders carry a checkbox**, and `[x]` only when every leaf beneath them is done
— recursively. `▾` is gone; a container is not a disclosure triangle, it is a
branch that either is or isn't finished.

**Colour means one thing.** Green is the task you are on, and it is the only row
coloured for being current. Amber is blocked — the one status that shouts
unasked. Finished work greys out. Everything else is white, folders included.
An earlier version also tinted the folder holding the active task and every
folder above it: three coloured rows for the single fact "you are here", which
made a nested board look busy rather than informative.

**Red is reserved for a halt.** When the nudges run out, the status and the count
both turn red. A board you stopped yourself is a normal state and reads as one —
colour it red and you learn to ignore the colour.

Every colour is a `ctx.theme` token, so the panel follows whatever theme is
active. There is not a single hex or `rgb()` in the panel, and a test fails if
one appears.

---

## 🧠 What the AI has access to

Three tools, no hidden surface, no ambient access, no filesystem or shell reach —
the board is the whole contract.

### The skill

The plugin also registers an **autoinvoking skill**, so a model is told the board
exists without having to go looking for it.

This came from watching it not happen. An agent was asked to track its work, and
hand-wrote a task list into a scratch file — while a purpose-built board sat in
the same session, unused. Nothing had gone wrong. The agent simply never knew
there was anything else, because the whole surface was three tool descriptions and
a `kanban_help` that only helps if you already suspect it.

That failure is silent, which is what makes it worth paying for. An agent
tracking work in the wrong place looks exactly like an agent that is working.

Set `autoinvoke: false` in `src/skill.ts` if you would rather list the skill than
inline its contents every turn.

### `kanban_read`

Read-only. Returns every item with its status and `detail`, which item is
current, progress counters, and the nudge state. Depth-first, one indent per
level, so nesting is visible rather than a flat list.

### `kanban_help`

The whole capability catalogue: every operation, **what it is for**, its
arguments, and a copyable example — plus the loop, the folder rules, and what the
nudge counter actually means.

This exists because of a real failure. The author knew how to drive the board
because they'd just written it. A new session knows nothing, sees two tool names,
and either guesses what twenty-two `op` values do or quietly uses the handful it
recognises. Knowledge that lives in one agent's head isn't a feature.

It is not a hand-written document. `src/catalog.ts` holds the catalogue as data
and **three** things read it:

- the `kanban_write` tool schema — so the op list a model sees cannot fall behind
  what is implemented;
- `kanban_help` — the full reference;
- `/ock help` — the same content, grouped for a human.

`test/catalog.test.ts` asserts the catalogue covers `REQUIRED_OPS` in both
directions, so adding an op without documenting it fails the suite.

### `kanban_write`

One mutation per call:

| Op | Fields | Does |
|---|---|---|
| `add` | `title`, `detail?`, `status?` | Append an item. `detail` is where acceptance criteria live |
| `addMany` | `items[]` | Append up to 500 as one validated batch |
| `folder` | `title`, `detail?` | A container that closes when its subtasks close |
| `subtask` | `parentID`, `title`, `detail?` | One task filed under a folder |
| `subtasks` | `parentID`, `items[]` | Many tasks under one folder |
| `reparent` | `id`, `parentID` | Re-file, or lift to top level with `""` |
| `update` | `id`, `title?`/`detail?`/`status?` | Patch an item |
| `updateMany` | `ids[]`, `…?` | The same patch on many |
| `remove` | `id` | Delete an item |
| `removeMany` | `ids[]` | Delete many |
| `move` | `id`, `to` | Reorder by index |
| `moveMany` | `ids[]`, `to` | Move a batch, order preserved |
| `current` | `id?` | Point a nudge at an item; omit to clear |
| `clear` | — | Empty the board |
| `pause` | — | Stop nudging |
| `resume` / `unpause` | — | Resume, resetting the counter |
| `nudge` | `enabled` | Restart policy on/off — **the human's** |
| `count` | `maxAttempts` | Tries before halting — **the human's** |
| `debug` | `enabled` | Activity log to `/tmp/opencode-kanban-debug.log` |
| `export` | `path?` | Write `.ai/tasks.md` — an indented checklist |
| `import` | `path?`/`content?`, `merge?` | Rebuild the board from a checklist |
| `template` | `path?` | Write a starter, one task per level, three deep |
| `notify` | `mode` | `"panel"` (block in the window) or `"toast"` |

Nesting has **no depth limit** — a folder can hold a folder. A folder is a
container, not a unit of work: marking one done by hand is refused, and it closes
itself once every descendant closes.

**Every one of those ops is also a slash command.** A capability you can only get
by asking a model to do it for you is not really a capability — and there is a
test that fails if the two surfaces ever drift apart.

### What the AI cannot do

It cannot write the board file directly, cannot lift a `pause` you set (a human
message never does that), and — deliberately — should not reach for `nudge`,
`count` or `debug` to escape a stall. Getting stuck is information, and the
person reading the board is the one who acts on it. Those are `ctx.options` and
human-only commands.

---

## 💾 Backup, restore, and a template

The board lives in `.opencode/kanban.json` — a plugin's private scratch space.
It is invisible in a diff, absent from a backup, and destroyed by anything that
cleans unknown directories. Someone who spent an hour with an agent decomposing a
project into forty tasks owns that work in exactly one place, and it is a place
they cannot easily see.

So the board gets a form a person can read, commit, and hand over.

```text
/ock export           ->  .ai/tasks.md
/ock import           ->  reads it back
/ock template         ->  .ai/tasks.template.md
```

`.ai/tasks.md` is an indented checklist — depth-first, `[ ]`/`[x]` per line:

```markdown
- [ ] Phase 1: compiler
  - [ ] Inventory the band-aids
    - [x] Remove the cross-assembly ctor path
- [-] Working on it now
- [!] Blocked on a decision
```

`/ock import` reads it back into the tree. **`/ock import replace`** swaps the
board out entirely — behind a confirmation, and never one keystroke from the safe
call, because it is the only operation that can lose what is already there.

Hand-written files work too: indentation *is* the nesting, so a list typed by a
person imports exactly like one this plugin wrote. `[ ]` `[x]` `[-]` `[!]` are
read as pending, done, in progress and blocked; anything unrecognised is read as
pending rather than failing the file, because the file is meant to be edited by
hand.

Any path must stay inside the project. An absolute path, or one that climbs out
with `../`, is refused — the agent picks these paths, and an agent can be talked
into `../../.ssh/authorized_keys` by anything it reads.

`/ock template` writes a starter showing **one task per level, three deep**,
which is the thing nobody can guess: whether nesting is allowed at all, and how
far.

---

## 📦 Install

OpenCode discovers plugins from `~/.config/opencode/plugins/`, so this is a
symlink and no config file:

```sh
ln -sfn /path/to/opencode-kanban ~/.config/opencode/plugins/opencode-kanban
```

The panel half is a CLI plugin and is configured separately, so it stays active
against a remote server:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": [{ "package": "/path/to/opencode-kanban" }]
}
```

Then **restart OpenCode**. Plugins resolve at server start, so a config change is
invisible to a running session.

### Verify it loaded

```sh
grep 'loading plugin' ~/.local/share/opencode/log/opencode.log | tail -1
```

```text
msg="loading plugin" id=.../plugins/opencode-kanban entrypoint=file://.../index.ts
```

Or just ask the agent: *"read your kanban board"*. If `kanban_read` answers, the
server half is live.

Requirements: **OpenCode 2.x**, Node 22.18+. The peer dependencies
(`@opencode/plugin`, `@opentui/*`, `solid-js`) come from the host.

---

## 🚀 Usage

**Daily loop**

1. Say what you want. The agent adds it to the board with `kanban_write`.
2. Watch the panel. `▸` marks what it is on.
3. It finishes something — that item gets `[x]` and the nudge counter resets.
4. It stops mid-way with work left — it nudges itself, up to three times.
5. After three, the panel says `halted 3/3` and waits. You decide.

**Adding work yourself**

```text
/ock add "a thing"
```

The agent picks the board up on its next read. You do not need to tell it.

**Reading the board without touching it**

```
kanban_read          → everything, including detail and nudge state
```

---

## 🔔 The nudge rules

Precise, because a restart policy you cannot predict is worse than none.

| Situation | What happens |
|---|---|
| Open work, session idle | Nudge with `kanban task <id>` |
| Third nudge spent | **Halt.** No fourth. Panel says `halted 3/3` |
| A human message arrives | Counter resets — talking is not consent to be nudged |
| An item reaches `done` | Counter resets and any halt lifts — progress is progress |
| Board empty or fully done | Never nudges, and clears the counter |
| `pause` set | Never nudges, whatever else is true |
| Human spoke < 5s ago | Does not nudge — you may be mid-sentence |

The nudge is a **synthetic** session message, so it is visibly not something you
typed, and it carries `resume: true` to restart the agent loop.

The counter is written to disk, so restarting OpenCode does not hand the agent a
fresh budget of three.

---

## ⌨️ Slash commands

One registered command, `/ock`, with a verb after it. Bare verbs like `/add` or
`/done` are the first thing any task plugin wants to claim, and on a public repo
somebody eventually will — one prefix cannot be taken by accident.
`/kanban` and `/ockanban` are registered as fallbacks.

```text
/ock help              the whole catalogue, grouped — same source as kanban_help
/ock                   open the panel, and list the verbs
/ock add "a thing"     add a task
/ock add k3 "a thing"  file it under folder k3
/ock done k5           mark done, and reset the try counter
/ock rm k1 k2 k3       remove several at once
/ock edit k5 "text"    rename
/ock current k5        point the marker, and any nudge, here
/ock folder "Phase 2"  add a container
/ock reparent k7 k3    re-file a task
/ock add-many          paste a list, one per line
/ock update-many       paste ids, then a status
/ock run | pause       resume or stop the board
/ock budget            how many tries before it halts
/ock control           the stop menu: resume / pause / budget / debug / clear
/ock clear             empty the board, behind a confirmation
/ock export            write .ai/tasks.md — a checklist you can read and commit
/ock import            read a checklist back; `replace` swaps the board out
/ock template          write a starter showing one task per level, three deep
/ock notify panel      changes are announced in a block in the window
/ock notify toast      …or as the host's own notification
```

Omit the ids and you get a picker instead. Verbs also accept the joined spelling
(`/ock addmany`) and the hyphenated one (`/ock nudge-on`), whichever you type.

---

## ⚙️ Options

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-kanban", "options": {
        "maxAttempts": 5,     // nudges before halting (default 3)
        "nudge": true,        // false keeps the tools and panel but never restarts
        "notify": "panel",    // "panel" = a coloured block in the window
                              // "toast" = the host's own notification
    } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `maxAttempts` | `3` | Nudges before halting |
| `nudge` | `true` | `false` keeps the tools and panel but never restarts the agent |

Want the panel without ever being restarted by a tool? Set `nudge: false`.

---

## 🗂️ Where the data lives

One file per worktree:

```text
.opencode/kanban.json
```

- **Human-readable**, atomic writes (temp file + rename, so a reader never sees a
  half-written board)
- **Per session.** Each session gets its own list under the same file, so a
  worktree experiment and your main line stay separate
- **Deleting a session deletes its board**
- A corrupt file is **quarantined** to `kanban.json.corrupt-<ts>-<rand>`, never
  overwritten — losing a board to a bug is bad, losing it *and the evidence* is worse

Add it to `.gitignore` if your task text is sensitive.

> This is a file rather than `ctx.storage` because the panel half is a separate
> plugin context in a separate process, and both halves must see the same board.

---

## 🩺 Troubleshooting

Every entry below is a trap that was actually hit while building this.

### The plugin does not appear at all

**Symptom:** no panel, and the agent has no `kanban_read`.

```sh
grep 'loading plugin' ~/.local/share/opencode/log/opencode.log | tail -1
```

**If that line is absent**, discovery did not find it. Three causes, in order of
likelihood:

1. **No root `index.ts`.** A plugin *directory* must contain `index.ts` at its
   root. An `exports` map pointing at `src/index.ts` is not consulted for
   discovery, and the plugin is skipped with **no diagnostic whatsoever**. This is
   the single most likely cause.
2. **Not in `~/.config/opencode/plugins/`.** A `plugins/` directory beside a
   project-root `opencode.json` is *not* discovered; it must be under `.opencode/`.
3. **No restart.** Discovery happens at server start.

### The tools work but there is no panel

The server half and the panel half register in **two different files**. Missing
`cli.json` gives you tools with no UI, which looks identical to a dead plugin:

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": [{ "package": "/path/to/opencode-kanban" }] }
```

### `opencode plugin add` refuses

```
Plugin target must be an npm registry package or Git package specifier
```

By design — it will not install a local plugin. Use the symlink.

### You named it by package name instead of path

```sh
plugins: ["opencode-kanban"]
```

OpenCode tries to fetch it from the npm registry and 404s:

```
WARN failed to load plugin target=opencode-kanban
  cause=NpmInstallFailedError (404 Not Found)
```

The warning names the plugin but not the mistake. Use the discovery symlink.

### `plugin` vs `plugins`

`plugin` (singular) is the deprecated key and is ignored for this. Use
`plugins`.

### It nudges when you did not want it to

```text
/ock stop
```

Permanent until `/ock continue`. To keep the panel but never be restarted at
all, set `nudge: false` in the options.

### It halted and you disagree

```text
/ock continue
```

Lifts the halt and resets the counter. If it halts again immediately, the board
genuinely has open work the agent cannot finish — which is the halt doing its job.

### The board is empty when you expected items

Boards are **per session**. A new session is a new board. Check the file to be
sure:

```sh
cat .opencode/kanban.json
```

### `kanban.json.corrupt-<ts>-<rand>` appeared

The board file was unreadable, so it was set aside rather than destroyed. The
current board is fresh. The quarantined file is still yours if you want it.

---

## 🧪 Development

```sh
npm test          # 229 tests, no host required
npm run typecheck
```

Tests run on plain Node with type stripping.

The interesting part is `src/nudge.ts`, which is **pure**: same board in, same
decision out, no I/O. That is why the state machine is testable without a host,
and it is where the real branching lives.

`src/catalog.ts` is the other one worth knowing about. It holds every operation
as data — summary, purpose, arguments, example, caveats — and generates the
`kanban_write` schema, `kanban_help`, and `/ock help` from it. A reference
handed to a model has to be impossible to drift from the thing it describes, or
it is worse than no reference: the model trusts it, acts on it, and fails in a way
nobody can explain.

`src/tui.tsx` cannot be imported by `node --test` (no JSX transform without a
bundler), so the things worth asserting about the UI — the command manifest, and
that every command has a handler — live in `src/commands.ts` and are tested there.

---

## 🏗️ How it's built

```text
src/types.ts      board and nudge types
src/board.ts      pure board reducer
src/nudge.ts      pure nudge state machine          <- the interesting one
src/actions.ts    every mutation, one write path
src/store.ts      atomic JSON persistence
src/format.ts     presentation
src/commands.ts   the command manifest, as data
src/catalog.ts    every operation, documented; drives the schema + both helps
src/markdown.ts   the board as a checklist, and back  (pure)
src/files.ts      project-root reads/writes, confined to the root
src/addargs.ts    /ock add <parent> "text" parsing
src/debug.ts      the activity log, and its env override for tests
src/index.ts      v2 server: kanban_read / kanban_write / kanban_help + the idle hook
src/tui.tsx       v2 TUI: the panel, dialogs, and keymap
index.ts          root entry, for plugin discovery
tui.ts            root TUI entry, for plugin discovery
```

### This is an OpenCode **v2** plugin

v1 and v2 plugin implementations are not interchangeable, and **a v1 plugin does
not run in v2 at all** — it fails silently. So this targets the v2 API throughout:

| Concern | v2 API |
|---|---|
| Entry point | `Plugin.define({ id, setup(ctx) })` |
| Agent tools | `ctx.tool.transform((editor) => editor.add(...))` |
| Events | `ctx.event.subscribe({ signal })` — an async iterator |
| The nudge | `ctx.session.synthetic({ text, resume: true })` |
| A human speaking | `ctx.session.hook("prompt", ...)` |
| The panel | the `session.panel` slot |
| Dialogs | `await ui.dialog.select/prompt/confirm(...)` |
| Commands | `ctx.keymap.layer(() => ({ commands }))` |
| Cleanup | the function `setup` returns |

Three things worth knowing if you port this yourself:

- Event payloads moved from `event.properties` to **`event.data`**.
- The v1 `sidebar_content` slot is gone; the panel uses **`session.panel`**, which
  is what gives you the right-hand pane and the full-screen fallback.
- v1 dialogs were JSX components with manual clearing; v2 dialogs are promises.

### One write path

The agent's tool and the panel's dialogs both go through `src/actions.ts`. So
validation happens once, and "an item reaching done resets the counter" has
exactly one implementation — a second code path quietly skipping that reset is
how you get a spurious halt at the worst possible moment.

### On the typing race

The obvious guard against nudging into a half-typed message is to watch the
composer. The plugin API cannot do that: slot placement is
`append`/`prepend`/`before`/`after`/`replace`, so there is no capture mode.

So the guard is built from state the API *does* expose — the `prompt` hook and a
five-second grace window after a human message. That covers the case that actually
matters (you have just spoken and may well speak again) without pretending to see
keystrokes it cannot see.

---

## 📄 License

MIT.