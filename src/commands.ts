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
  /** The word typed after `/`. Must be unique across plugins. */
  slashName: string
  /** One line explaining when you would want this. */
  hint: string
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "kanban.open",
    title: "Kanban: open the panel",
    category: "Kanban",
    slashName: "kanban",
    hint: "Un-collapse the board and refresh it",
  },
  {
    name: "kanban.add",
    title: "Kanban: add a task",
    category: "Kanban",
    slashName: "kanban-add",
    hint: "Type a task into a dialog; the agent sees it immediately",
  },
  {
    name: "kanban.done",
    title: "Kanban: mark a task done",
    category: "Kanban",
    slashName: "kanban-done",
    hint: "Pick an item to mark done; this also clears the nudge counter",
  },
  {
    name: "kanban.remove",
    title: "Kanban: remove a task",
    category: "Kanban",
    slashName: "kanban-remove",
    hint: "Pick an item to delete",
  },
  {
    name: "kanban.move",
    title: "Kanban: reorder a task",
    category: "Kanban",
    slashName: "kanban-move",
    hint: "Pick an item, then where it should go",
  },
  {
    name: "kanban.current",
    title: "Kanban: set the current task",
    category: "Kanban",
    slashName: "kanban-current",
    hint: "Pick the item the agent should be on; a nudge points here",
  },
  {
    name: "kanban.edit",
    title: "Kanban: edit a task",
    category: "Kanban",
    slashName: "kanban-edit",
    hint: "Fix the text or the acceptance criteria of an item",
  },
  {
    name: "kanban.clear",
    title: "Kanban: clear the board",
    category: "Kanban",
    slashName: "kanban-clear",
    hint: "Delete every item, after a confirmation",
  },
  {
    name: "kanban.control",
    title: "Kanban: nudge control",
    category: "Kanban",
    slashName: "kanban-control",
    hint: "Pause, resume, or clear — the stop menu",
  },
  {
    name: "kanban.continue",
    title: "Kanban: continue (lift a nudge halt)",
    category: "Kanban",
    slashName: "kanban-continue",
    hint: "Reset the counter and start nudging again",
  },
  {
    name: "kanban.stop",
    title: "Kanban: stop nudging",
    category: "Kanban",
    slashName: "kanban-stop",
    hint: "Stop the plugin from ever nudging again until you resume it",
  },
]

/** Shown in the panel when nudging has halted. Must name a real command. */
export const HALT_HINT = "say /kanban-continue to resume"

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
  "update",
  "remove",
  "move",
  "current",
  "clear",
  "pause",
  "resume",
  "unpause",
] as const

/**
 * Which slash command reaches each operation.
 *
 * Declared as data so the test can assert both directions: every op is
 * reachable by a human, and every slash command in this map is a real command.
 * Without this, "reorder works" and "I can reorder" are separate claims, and
 * only the first one gets tested.
 */
export const OP_COMMANDS: Record<(typeof REQUIRED_OPS)[number], string> = {
  add: "kanban-add",
  update: "kanban-edit",
  remove: "kanban-remove",
  move: "kanban-move",
  current: "kanban-current",
  clear: "kanban-clear",
  pause: "kanban-stop",
  resume: "kanban-continue",
  unpause: "kanban-control",
}