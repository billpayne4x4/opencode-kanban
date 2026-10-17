/**
 * The command manifest, as data.
 *
 * These strings are what the human actually sees — in `/` autocomplete, in the
 * command palette, and in the `⟳ 2/3` hint the panel prints when it halts. That
 * makes them worth testing, and they live here rather than inside `tui.tsx`
 * because a `.tsx` file cannot be imported by `node --test` (no JSX transform
 * without a bundler), and a manifest is exactly the kind of thing that rots
 * silently when it is welded to a renderer.
 *
 * `tui.tsx` maps this manifest onto handlers by `name`.
 */

/** One command the human can run. */
export type CommandSpec = {
  /** Stable id; the handler key in `tui.tsx`. */
  name: string
  title: string
  category: string
  /** Typed after the root prefix, e.g. `add` in `/ock add "…"`. */
  readonly verb?: string
  /** One line explaining when you would want this. */
  hint: string
}

/**
 * `/ock <verb> ...` — a single namespaced command rather than a dozen flat
 * ones.
 *
 * Bare verbs like `/add`, `/done` and `/rm` are the ones that actually collide:
 * they are the first thing any task-tracking plugin wants, and on a public repo
 * somebody will take them. One prefix cannot be taken twice by accident, because
 * `kanban` is *this* plugin's whole identity.
 *
 * `/ockanban` is registered as an alias for collision insurance: if another
 * plugin ever claims `/kanban`, the prefixed form still works.
 */
/**
 * The prefix to type.
 *
 * `ock` rather than `kanban`: short, and nobody else picks it. `kanban` is
 * readable but is exactly the word a competing task plugin would claim, and on
 * a public repo somebody will. Both are registered — `kanban` for readability,
 * `ock` as the one that survives a collision — so a lost name is never fatal.
 *
 * Override with the `commandPrefix` option if you would rather have `/tasks`.
 */
export const DEFAULT_ROOT = "ock"
export const ROOT_ALIASES = ["kanban", "ockanban"]

/**
 * verb → what it does. The rest of each line is the verb's own arguments, so
 * `/ock add k3 "a subtask"` splits cleanly on the first token.
 */
export const VERBS: Record<string, string> = {
  help: "everything the board can do, for a human — same catalogue the agent reads",
  add: "add a task, or a subtask under a parent",
  "add-many": "add many at once: paste a list, one per line",
  "remove-many": "remove many at once: /ock remove-many k30 k31 k32",
  "move-many": "move many at once: /ock move-many k5 k6",
  "update-many": "update many at once: /ock update-many k5 k6",
  done: "mark done: /ock done k5",
  edit: 'rename: /ock edit k5 "new text"',
  rm: "remove one or many: /ock rm k1 k2",
  current: "set what a nudge points at: /ock current k5",
  move: "reorder: /ock move k5 2",
  folder: "add a container that closes when its subtasks close",
  subtask: "file a task under a folder",
  subtasks: "add many subtasks under a folder",
  reparent: "re-file a task: /ock reparent k5 k2",
  clear: "empty the board",
  run: "resume the board",
  pause: "pause the board",
  stop: "stop nudging",
  control: "the stop menu — pause, resume, budget, debug, all in one dialog",
  continue: "lift a halt and reset the counter",
  nudgeon: "allow the plugin to restart a stalled agent",
  "nudge-on": "allow the plugin to restart a stalled agent",
  nudgeoff: "keep the board but never be restarted by it",
  "nudge-off": "keep the board but never be restarted by it",
  budget: "set how many tries before it halts",
  debugon: "log everything to /tmp/opencode-kanban-debug.log",
  "debug-on": "log everything to /tmp/opencode-kanban-debug.log",
  debugoff: "stop logging",
  "debug-off": "stop logging",
  debuglog: "print where the log is",
  log: "print where the log is",
  export: "write the board to .ai/tasks.md as an indented checklist",
  import: "rebuild the board from a checklist file",
  template: "write a starter template with one task per level, three deep",
  notify: "where changes are announced: /ock notify toast|panel",
}

/**
 * Per-verb help, shown by `/ock` with no arguments.
 *
 * These are *not* separately registered slash commands — the single `/ock`
 * command dispatches on the first word, so nothing here claims a global name.
 * That is the whole point of namespacing.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "kanban.help",
    title: "Kanban: help",
    category: "Kanban",
    hint: "Every operation, what it is for, and its slash equivalent",
    verb: "help",
  },
  {
    name: "kanban.export",
    title: "Kanban: export the task list",
    category: "Kanban",
    hint: "Write .ai/tasks.md — an indented checklist you can read, commit and hand over",
    verb: "export",
  },
  {
    name: "kanban.import",
    title: "Kanban: import tasks from a file",
    category: "Kanban",
    hint: "Rebuild the board from a checklist. Add to it, or replace it",
    verb: "import",
  },
  {
    name: "kanban.template",
    title: "Kanban: write a starter template",
    category: "Kanban",
    hint: "One task per level, three deep — the nesting rules, shown rather than described",
    verb: "template",
  },
  {
    name: "kanban.notify",
    title: "Kanban: where notifications appear",
    category: "Kanban",
    hint: "Switch between a coloured block in the window and the host's own toast",
    verb: "notify",
  },
  {
    name: "kanban.open",
    title: "Kanban: open the panel",
    category: "Kanban",
    hint: `No verb opens the panel. ${Object.keys(VERBS).length} verbs are listed inside.`,
  },
  {
    name: "kanban.add",
    title: "Kanban: add a task",
    category: "Kanban",
    hint: "Type a task into a dialog; the agent sees it immediately",
  },
  {
    name: "kanban.done",
    title: "Kanban: mark a task done",
    category: "Kanban",
    hint: "Pick an item to mark done; this also clears the nudge counter",
  },
  {
    name: "kanban.remove",
    title: "Kanban: remove a task",
    category: "Kanban",
    hint: "Pick an item to delete",
  },
  {
    name: "kanban.move-many",
    title: "Kanban: move many tasks",
    category: "Kanban",
    hint: "Paste ids and a destination — move a whole block to the top or anywhere else",
  },
  {
    name: "kanban.update-many",
    title: "Kanban: update many tasks",
    category: "Kanban",
    hint: "Paste ids and a status — mark a whole block done, blocked or pending",
  },
  {
    name: "kanban.remove-many",
    title: "Kanban: remove many tasks",
    category: "Kanban",
    hint: "Paste ids like k30, k31, k32 to trim a range in one go",
  },
  {
    name: "kanban.folder",
    title: "Kanban: add a folder",
    category: "Kanban",
    hint: "A container that closes when its subtasks close — not a unit of work itself",
  },
  {
    name: "kanban.subtask",
    title: "Kanban: add a subtask",
    category: "Kanban",
    hint: "File one task under a folder",
  },
  {
    name: "kanban.subtasks",
    title: "Kanban: add many subtasks",
    category: "Kanban",
    hint: "Paste a list, one per line, filed under a folder in a single call",
  },
  {
    name: "kanban.reparent",
    title: "Kanban: re-file a task",
    category: "Kanban",
    hint: "Move a task into or out of a folder",
  },
  {
    name: "kanban.move",
    title: "Kanban: reorder a task",
    category: "Kanban",
    hint: "Pick an item, then where it should go",
  },
  {
    name: "kanban.current",
    title: "Kanban: set the current task",
    category: "Kanban",
    hint: "Pick the item the agent should be on; a nudge points here",
  },
  {
    name: "kanban.add-many",
    title: "Kanban: add many tasks at once",
    category: "Kanban",
    hint: "Paste a list, one task per line — validated as a batch before anything is written",
  },
  {
    name: "kanban.edit",
    title: "Kanban: edit a task",
    category: "Kanban",
    hint: "Fix the text or the acceptance criteria of an item",
  },
  {
    name: "kanban.clear",
    title: "Kanban: clear the board",
    category: "Kanban",
    hint: "Delete every item, after a confirmation",
  },
  {
    name: "kanban.run",
    title: "Kanban: run (resume work)",
    category: "Kanban",
    hint: "Clear the pause and carry on with the board",
  },
  {
    name: "kanban.pause",
    title: "Kanban: pause",
    category: "Kanban",
    hint: "Pause the board; nothing restarts until you resume",
  },
  {
    name: "kanban.nudge-on",
    title: "Kanban: turn nudging on",
    category: "Kanban",
    hint: "Allow the plugin to restart a stalled agent",
  },
  {
    name: "kanban.nudge-off",
    title: "Kanban: turn nudging off",
    category: "Kanban",
    hint: "Keep the board, but never be restarted by it",
  },
  {
    name: "kanban.budget",
    title: "Kanban: set the nudge count",
    category: "Kanban",
    hint: "Choose how many nudges before it halts",
  },
  {
    name: "kanban.debug-on",
    title: "Kanban: debug logging on",
    category: "Kanban",
    hint: "Log every tool call, event, nudge and command to /tmp/opencode-kanban-debug.log",
  },
  {
    name: "kanban.debug-off",
    title: "Kanban: debug logging off",
    category: "Kanban",
    hint: "Stop writing the activity log and hide its marker from the panel",
  },
  {
    name: "kanban.control",
    title: "Kanban: nudge control",
    category: "Kanban",
    hint: "Pause, resume, or clear — the stop menu",
  },
  {
    name: "kanban.continue",
    title: "Kanban: continue (lift a nudge halt)",
    category: "Kanban",
    hint: "Reset the counter and start nudging again",
  },
  {
    name: "kanban.stop",
    title: "Kanban: stop nudging",
    category: "Kanban",
    hint: "Stop the plugin from ever nudging again until you resume it",
  },
]

/** Shown in the panel when nudging has halted. Must name a real command. */
export const HALT_HINT = "say /ock continue to resume"

/**
 * Every board operation, as a user-facing command.
 *
 * This exists as a list so `commands.test.ts` can hold the plugin to it: the
 * test asserts that the agent's tool surface and the human's command surface
 * cover the same operations. A capability reachable only by the agent is a
 * capability you cannot use without asking a model to do it for you.
 */
export const REQUIRED_OPS = [
  "add",
  "addMany",
  "removeMany",
  "moveMany",
  "updateMany",
  "update",
  "remove",
  "move",
  "folder",
  "subtask",
  "subtasks",
  "reparent",
  "current",
  "clear",
  "pause",
  "resume",
  "unpause",
  "nudge",
  "count",
  "debug",
  "export",
  "import",
  "template",
  "notify",
] as const

/**
 * Which verb reaches each operation, e.g. `add` -> the `add` verb.
 *
 * Declared as data so the test can assert both directions: every op is
 * reachable by a human, and every slash command in this map is a real command.
 * Without this, "reorder works" and "I can reorder" are separate claims, and
 * only the first one gets tested.
 */
export const OP_COMMANDS: Record<(typeof REQUIRED_OPS)[number], string> = {
  add: "add",
  addMany: "add-many",
  update: "edit",
  remove: "remove",
  removeMany: "remove-many",
  moveMany: "move-many",
  updateMany: "update-many",
  move: "move",
  folder: "folder",
  subtask: "subtask",
  subtasks: "subtasks",
  reparent: "reparent",
  current: "current",
  clear: "clear",
  pause: "pause",
  resume: "run",
  unpause: "control",
  nudge: "nudge-on",
  count: "budget",
  debug: "debug-on",
  export: "export",
  import: "import",
  template: "template",
  notify: "notify",
}