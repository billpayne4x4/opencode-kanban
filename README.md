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

> **Three nudges. Then it halts, tells you, and waits for `/kanban-continue`.**

---

## 📸 The panel

The board lives in a right-hand pane that the host promotes to full screen on a
narrow terminal. Scroll and focus belong to the host, so it behaves like the rest
of the UI.

```text
OpenCode Kanban (2/5)
────────────────────
▸ [x] Remove the band-aid folds
  [ ] Add the IR-invariance gate
  [ ] Relocate the policy folds
  [ ] Prove the general replacement
⟳ nudge 1/3
```

| Element | Meaning |
|---|---|
| `(2/5)` | done / total. An empty board reads `(0/0)` — it never disappears |
| `[x]` / `[ ]` | finished / not finished. Only two states, so the column reads as a column |
| `▸` | the item a nudge would point at |
| `⟳ nudge 1/3` | the restart counter, always visible so a nudge is never a surprise |
| `halted 3/3` | it gave up on restarting the agent, and is waiting for you |

---

## 🧠 What the AI has access to

Exactly two tools. No hidden surface, no ambient access, no filesystem or shell
reach — the board is the whole contract.

### `kanban_read`

Read-only. Returns every item with its status and `detail`, which item is
current, progress counters, and the nudge state.

### `kanban_write`

One mutation per call:

| Op | Fields | Does |
|---|---|---|
| `add` | `title`, `detail?`, `status?` | Append an item. `detail` is where acceptance criteria live |
| `update` | `id`, `title?`/`detail?`/`status?` | Patch an item |
| `remove` | `id` | Delete an item |
| `move` | `id`, `to` | Reorder by index |
| `current` | `id?` | Point a nudge at an item; omit to clear |
| `clear` | — | Empty the board |
| `pause` | — | Stop nudging; never cleared by the agent |
| `resume` | — | Resume nudging and reset the counter |
| `unpause` | — | Resume but keep the counter |

**Every one of those ops is also a slash command.** A capability you can only get
by asking a model to do it for you is not really a capability — and there is a
test that fails if the two surfaces ever drift apart.

### What the AI cannot do

It cannot write the board file directly, cannot clear the board without the op,
cannot lift a `pause` you set (a human message never does that), and cannot
change the attempt budget. Those are all `ctx.options` and human-only commands.

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
/kanban-add
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

| Command | Does |
|---|---|
| `/kanban` | Open the panel |
| `/kanban-add` | Type a task into a dialog |
| `/kanban-edit` | Fix an item's text |
| `/kanban-done` | Mark an item done — also resets the counter |
| `/kanban-remove` | Delete an item |
| `/kanban-move` | Reorder: pick an item, then up / down / top / bottom |
| `/kanban-current` | Set the item a nudge points at |
| `/kanban-clear` | Delete everything, behind a confirmation |
| `/kanban-control` | Stop menu: resume / un-pause / pause / mark-all-done / clear |
| `/kanban-continue` | Lift a halt and reset the counter |
| `/kanban-stop` | Stop nudging entirely until you resume it |

---

## ⚙️ Options

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-kanban", "options": { "maxAttempts": 5 } }
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
/kanban-stop
```

Permanent until `/kanban-continue`. To keep the panel but never be restarted at
all, set `nudge: false` in the options.

### It halted and you disagree

```text
/kanban-continue
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
npm test          # 99 tests, no host required
npm run typecheck
```

Tests run on plain Node with type stripping.

The interesting part is `src/nudge.ts`, which is **pure**: same board in, same
decision out, no I/O. That is why the state machine is testable without a host,
and it is where the real branching lives.

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
src/index.ts      v2 server: kanban_read / kanban_write + the idle hook
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