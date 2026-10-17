/**
 * The capability catalogue: every board operation, as data.
 *
 * This exists because of a specific failure. I knew how to drive the board,
 * because I had just written it. A new session knows nothing, sees two tool
 * names, and has to guess what twenty-two `op` values do — which means it
 * guesses wrong, or refuses to use half the board. Knowledge that only lives in
 * one agent's head is not a feature.
 *
 * So the answer is a single registry that describes the surface in intent
 * terms ("use this when…"), not just signatures, and three consumers read it:
 *
 * - `WRITE_DESCRIPTION` — the `kanban_write` tool schema, so the list the model
 *   sees can never drift from what is implemented;
 * - `agentHelp()` — the body of the `kanban_help` tool, for a cold session;
 * - `humanHelp()` — `/ock help`, grouped for reading rather than for parsing.
 *
 * One source, three audiences. `catalog.test.ts` holds it to
 * `REQUIRED_OPS` in both directions, so adding an op without documenting it
 * fails the suite instead of shipping a silent hole.
 */

import { DEFAULT_ROOT } from "./commands.ts"
import { TASKS_DIR, TASKS_FILE, TEMPLATE_FILE } from "./markdown.ts"

const TASKS_PATH = `${TASKS_DIR}/${TASKS_FILE}`
const TEMPLATE_PATH = `${TASKS_DIR}/${TEMPLATE_FILE}`
import { DEBUG_LOG } from "./debug.ts"

/** One argument, as the model needs to see it. */
export type CatalogArg = {
  name: string
  type: string
  meaning: string
  /** Set when the argument is required for this op to do anything. */
  required?: boolean
}

/** One operation in the catalogue. */
export type CatalogEntry = {
  /** The `op` value `kanban_write` takes. */
  op: string
  /** The verb that reaches the same thing for a human, without the prefix. */
  verb?: string
  /** One line: what it does. */
  summary: string
  /**
   * When to reach for it.
   *
   * Deliberately not a restatement of `summary`. The summary answers "what is
   * this", the purpose answers "why would I", and the second one is the only
   * thing that stops a model reaching for `moveMany` when it meant `move`.
   */
  purpose: string
  args: CatalogArg[]
  /** A literal, copyable `kanban_write` call. */
  example: string
  /** Things that will make it refuse, or that a caller gets wrong. */
  notes?: string[]
  /** Deletes work with no undo. Worth saying out loud. */
  destructive?: boolean
  /**
   * Internal plumbing. Implemented, deliberately not documented, and not
   * reachable by a human verb — the host calls it, nobody asks for it.
   */
  internal?: boolean
}

/** Grouping for `/ock help`, which reads better by intent than alphabetically. */
export type CatalogGroup = {
  title: string
  blurb: string
  entries: CatalogEntry[]
}

/**
 * Everything `kanban_write` accepts.
 *
 * Ordered by the loop you actually work in — plan, then nest, then execute,
 * then prune, then the controls — rather than by op name, because the model
 * reads top to bottom and a plan is not a reorganisation.
 */
export const ENTRIES: readonly CatalogEntry[] = [
  {
    op: "add",
    verb: "add",
    summary: "Add one task.",
    purpose: "The single item case. When you have exactly one thing to queue, this is the call.",
    args: [
      { name: "title", type: "string", meaning: "What needs doing. Kept to 200 characters.", required: true },
      { name: "detail", type: "string", meaning: "Acceptance criteria, a file path, anything you will need to act on." },
      { name: "status", type: '"pending" | "in_progress" | "done" | "blocked"', meaning: "Defaults to pending." },
    ],
    example: '{ op: "add", title: "Parse the .rcp manifests", detail: "acceptance: 181 files listed" }',
  },
  {
    op: "addMany",
    verb: "add-many",
    summary: "Add up to 500 tasks in one call, validated as a batch.",
    purpose:
      "Use this the moment you already know the plan. It is one round trip instead of N, and the whole batch is checked before anything is written, so a typo in the last entry cannot leave a half-built board.",
    args: [
      { name: "items", type: "array of {title, detail?, status?}", meaning: "Up to 500. Order is preserved.", required: true },
    ],
    example: '{ op: "addMany", items: [{ title: "Step one" }, { title: "Step two", detail: "why" }] }',
    notes: ["Prefer this over repeated `add`. There is no reason to make N calls when one will do."],
  },
  {
    op: "folder",
    verb: "folder",
    summary: "Add a container that closes when its subtasks close.",
    purpose:
      "Use for a phase, a component, or any grouping of work that should read as done when its parts are. A folder is not a unit of work: it has no work of its own and cannot be marked done by hand.",
    args: [
      { name: "title", type: "string", meaning: "The grouping's name.", required: true },
      { name: "detail", type: "string", meaning: "What the group covers." },
    ],
    example: '{ op: "folder", title: "Phase 2: codegen", detail: "everything after lowering" }',
    notes: [
      "Marking a folder done by hand is REFUSED. Close its subtasks and it closes itself.",
      "Nesting is unlimited — a folder can hold a folder. Nothing caps the depth.",
    ],
  },
  {
    op: "subtask",
    verb: "subtask",
    summary: "File one task under a folder.",
    purpose: "When the group already exists and you are adding one more piece to it.",
    args: [
      { name: "parentID", type: "string", meaning: "The folder's id.", required: true },
      { name: "title", type: "string", meaning: "What needs doing.", required: true },
      { name: "detail", type: "string", meaning: "Acceptance criteria." },
    ],
    example: '{ op: "subtask", parentID: "k3", title: "Audit eval.rs" }',
  },
  {
    op: "subtasks",
    verb: "subtasks",
    summary: "File many tasks under one folder in a single call.",
    purpose: "The nested equivalent of `addMany`. Same reason, same batch guarantee.",
    args: [
      { name: "parentID", type: "string", meaning: "The folder's id.", required: true },
      { name: "items", type: "array of {title, detail?}", meaning: "Up to 500, in order.", required: true },
    ],
    example: '{ op: "subtasks", parentID: "k3", items: [{ title: "Audit eval.rs" }, { title: "Fold the guards" }] }',
  },
  {
    op: "reparent",
    verb: "reparent",
    summary: "Move a task into or out of a folder.",
    purpose: "When the grouping was wrong, not the work. Reach for this instead of remove-and-re-add: it keeps the id, so anything pointing at it still points at it.",
    args: [
      { name: "id", type: "string", meaning: "The task to move.", required: true },
      { name: "parentID", type: 'string, or "" for top level', meaning: "Where it goes.", required: true },
    ],
    example: '{ op: "reparent", id: "k7", parentID: "k3" } // "" lifts it to the top level',
    notes: ["A loop is refused: you cannot file a folder inside something it already contains."],
  },
  {
    op: "update",
    verb: "edit",
    summary: "Change a task's text, detail, or status.",
    purpose: "Marking work done, and correcting a plan that was wrong about the work.",
    args: [
      { name: "id", type: "string", meaning: "The task.", required: true },
      { name: "status", type: '"pending" | "in_progress" | "done" | "blocked"', meaning: "Only `done` and `blocked` are useful day to day." },
      { name: "title", type: "string", meaning: "A better title." },
      { name: "detail", type: "string", meaning: "Better acceptance criteria." },
    ],
    example: '{ op: "update", id: "k4", status: "done" }',
    notes: [
      "Marking something done RESETS the nudge counter — finishing work is what clearing the counter means.",
      "Only the fields you pass change.",
    ],
  },
  {
    op: "updateMany",
    verb: "update-many",
    summary: "Apply the same change to many tasks at once.",
    purpose: "'Mark these five blocked', 'renumber this whole block'. One call instead of one per task.",
    args: [
      { name: "ids", type: "array of strings", meaning: "Up to 500 ids.", required: true },
      { name: "status", type: "status", meaning: "Applied to every id." },
      { name: "title", type: "string", meaning: "Applied to every id." },
      { name: "detail", type: "string", meaning: "Applied to every id." },
    ],
    example: '{ op: "updateMany", ids: ["k8", "k9", "k10"], status: "blocked" }',
  },
  {
    op: "remove",
    verb: "rm",
    summary: "Delete one task.",
    purpose: "When a planned step turns out to be wrong or already done and not worth keeping.",
    args: [{ name: "id", type: "string", meaning: "The task.", required: true }],
    example: '{ op: "remove", id: "k6" }',
    destructive: true,
  },
  {
    op: "removeMany",
    verb: "rm",
    summary: "Delete many tasks in one call.",
    purpose: "Trimming a plan in bulk. Removing 40 items one at a time is 40 round trips and usually a sign you are reacting to noise rather than editing.",
    args: [{ name: "ids", type: "array of strings", meaning: "Up to 500 ids.", required: true }],
    example: '{ op: "removeMany", ids: ["k30", "k31", "k32"] }',
    destructive: true,
  },
  {
    op: "move",
    verb: "move",
    summary: "Reorder one task.",
    purpose: "When priority changed. `to` is an index: 0 is the very top.",
    args: [
      { name: "id", type: "string", meaning: "The task.", required: true },
      { name: "to", type: "number", meaning: "Target index. 0 = top, -1 = end.", required: true },
    ],
    example: '{ op: "move", id: "k7", to: 0 }',
  },
  {
    op: "moveMany",
    verb: "move-many",
    summary: "Move a batch to one position, keeping the order given.",
    purpose: "'Put this whole block at the front' — the actual intent behind reordering. Preserves your ordering, so it is not a pile-up.",
    args: [
      { name: "ids", type: "array of strings", meaning: "Up to 500, in the order you want them.", required: true },
      { name: "to", type: "number", meaning: "Target index. 0 = top, -1 = end.", required: true },
    ],
    example: '{ op: "moveMany", ids: ["k12", "k13"], to: 0 }',
  },
  {
    op: "current",
    verb: "current",
    summary: "Point the marker — and any nudge — at one task.",
    purpose: "To say which thing you are on when the board alone is ambiguous. A nudge targets whatever this names.",
    args: [
      { name: "id", type: "string", meaning: "The task. Omit it to clear." },
    ],
    example: '{ op: "current", id: "k5" }',
    notes: ["With no `id`, it clears. With none set, the first pending task is used."],
  },
  {
    op: "clear",
    verb: "clear",
    summary: "Delete every task.",
    purpose: "Starting over. Almost never correct mid-task — prefer removing what is wrong.",
    args: [],
    example: '{ op: "clear" }',
    destructive: true,
    notes: ["Everything goes, including subtasks and the nesting. There is no undo."],
  },
  {
    op: "pause",
    verb: "pause",
    summary: "Stop the board being restarted.",
    purpose: "When work should stop being automatic but the board should stay readable.",
    args: [],
    example: '{ op: "pause" }',
  },
  {
    op: "resume",
    verb: "run",
    summary: "Clear the pause and carry on.",
    purpose: "When the human wants nudging back. Also resets the try counter.",
    args: [],
    example: '{ op: "resume" }',
  },
  {
    op: "unpause",
    verb: "control",
    summary: "Alias of `resume`, kept for callers using the older name.",
    purpose: "Same effect. You do not need this — `resume` says what it means.",
    args: [],
    example: '{ op: "unpause" }',
  },
  {
    op: "nudge",
    verb: "nudge-on / nudge-off",
    summary: "Turn the restart policy on or off.",
    purpose: "The human's switch, not yours. See the rules below.",
    args: [{ name: "enabled", type: "boolean", meaning: "true allows restarts, false never does.", required: true }],
    example: '{ op: "nudge", enabled: true }',
    notes: ["Do not use this to work around your own stall. It is a human control."],
  },
  {
    op: "count",
    verb: "budget",
    summary: "Set how many restarts happen before halting.",
    purpose: "The human's control. Setting it resets the counter.",
    args: [{ name: "maxAttempts", type: "number", meaning: "1–9999.", required: true }],
    example: '{ op: "count", maxAttempts: 3 }',
    notes: ["Do not raise the budget to avoid halting. That is the halt doing its job."],
  },
  {
    op: "debug",
    verb: "debug-on / debug-off",
    summary: "Log every call, event and nudge to a file.",
    purpose: "When a board is behaving oddly and you need the trail. Off by default; the panel shows a marker only while it is on.",
    args: [{ name: "enabled", type: "boolean", meaning: "true starts logging.", required: true }],
    example: '{ op: "debug", enabled: true }',
  },
  {
    op: "export",
    verb: "export",
    summary: "Write the board to `.ai/tasks.md` as an indented checklist.",
    purpose:
      "Before something that could lose the board — a long build, a risky refactor, or handing the work to someone else. The board lives in a plugin's private JSON, which is invisible in a diff and absent from a backup. This is the form a person can read.",
    args: [
      { name: "path", type: "string", meaning: `Where to write, relative to the project root. Defaults to ${TASKS_PATH}.` },
    ],
    example: '{ op: "export" }',
    notes: [
      "One file, one board, every level indented. `import` reads it back.",
      "The path must stay inside the project; `../` is refused.",
    ],
  },
  {
    op: "import",
    verb: "import",
    summary: "Rebuild the board from a checklist file or from text.",
    purpose:
      "Restoring a backup, or adopting a plan someone wrote. Indentation is the nesting, so a hand-written list works as well as one this plugin wrote.",
    args: [
      { name: "path", type: "string", meaning: `The checklist to read. Defaults to ${TASKS_PATH}.` },
      { name: "content", type: "string", meaning: "The checklist itself, when you already have the text. Skips the filesystem." },
      { name: "merge", type: "boolean", meaning: "true (default) adds to the board; false replaces it. False is the restore path and the only one that loses what is here." },
    ],
    example: '{ op: "import", path: ".ai/tasks.md", merge: false }',
    notes: [
      "Needs `path` or `content` — one of them, not neither.",
      "Any line with children becomes a folder, and a folder closes from its subtasks rather than by hand.",
      "`[ ]` `[x]` `[-]` `[!]` are read as pending, done, in progress and blocked.",
    ],
  },
  {
    op: "template",
    verb: "template",
    summary: "Write a starter template showing one task per level, three deep.",
    purpose:
      "When someone asks how nesting works. The depth is the part nobody can guess, so the template shows it rather than describing it.",
    args: [
      { name: "path", type: "string", meaning: `Where to write. Defaults to ${TEMPLATE_PATH}.` },
    ],
    example: '{ op: "template" }',
  },
  {
    op: "notify",
    verb: "notify",
    summary: "Choose where changes are announced: a block in the window, or a toast.",
    purpose: "If the host's notifications are wrong for you — too little, too much, or in the wrong place.",
    args: [
      { name: "mode", type: '"toast" | "panel"', meaning: "Which one to use from now on.", required: true },
    ],
    example: '{ op: "notify", mode: "panel" }',
    notes: ["This is the human's setting as much as yours; either way it sticks for the session."],
  },
  {
    op: "composer",
    summary: "Internal: records whether the human is typing.",
    purpose: "Not yours to call. The host uses it to give the human a grace window so a nudge never interrupts a half-typed message.",
    args: [{ name: "busy", type: "boolean", meaning: "Whether a composer edit is open.", required: true }],
    example: '{ op: "composer", busy: true }',
    internal: true,
  },
]

/** The reading tool, described alongside the writing one. */
export const READ_ENTRY: CatalogEntry = {
  op: "read",
  summary: "Read the whole board: items, statuses, details, progress, nudge state.",
  purpose:
    "Call this at the START of every turn, before deciding what to do. It is the only way to see what is outstanding, what is current, and how many tries the nudge has left.",
  args: [],
  example: "kanban_read()",
  notes: [
    "Read-only, and cheap. Reading is never the wrong move when you are unsure.",
    "Output is depth-first with an indent per level, so nesting is visible.",
  ],
}

const HELP_ENTRY: CatalogEntry = {
  op: "help",
  summary: "This catalogue: every operation, what it is for, and an example.",
  purpose: "Call it when you are unsure what an op does, or what this board can do at all. It is documentation, and it costs nothing.",
  args: [],
  example: "kanban_help()",
}

/** Grouped for `/ock help`, where a flat list of 22 lines is worse than useless. */
export const GROUPS: readonly CatalogGroup[] = [
  {
    title: "Plan the work",
    blurb: "Before touching anything, put the steps on the board.",
    entries: ["add", "addMany", "folder", "subtask", "subtasks"].map(byOp),
  },
  {
    title: "Work through it",
    blurb: "Claim a task, finish it, correct the plan when reality disagrees.",
    entries: ["update", "updateMany", "current", "move", "moveMany", "reparent"].map(byOp),
  },
  {
    title: "Prune it",
    blurb: "Plans change. Removing what is wrong beats leaving it to rot.",
    entries: ["remove", "removeMany", "clear"].map(byOp),
  },
  {
    title: "Back it up",
    blurb: "The board is one JSON file in a plugin's private space. Make it something you can read.",
    entries: ["export", "import", "template"].map(byOp),
  },
  {
    title: "Controls",
    blurb: "Pause and resume are yours when you stall on purpose. nudge, count and debug are the human's.",
    entries: ["pause", "resume", "unpause", "nudge", "count", "debug", "notify"].map(byOp),
  },
]

function byOp(op: string): CatalogEntry {
  const entry = ENTRIES.find((candidate) => candidate.op === op)
  if (!entry) throw new Error(`catalog group names an op that does not exist: ${op}`)
  return entry
}

/** Every op, documented ones only. */
export function publicEntries(): CatalogEntry[] {
  return ENTRIES.filter((entry) => !entry.internal)
}

/** `op (title, detail, status)` — the signature line for the tool schema. */
function signature(entry: CatalogEntry): string {
  const names = entry.args.filter((arg) => arg.required).map((arg) => arg.name)
  return `${entry.op}${names.length ? ` (${names.join(", ")})` : ""}`
}

/** The optional arguments, as a trailing clause: ` — title?, detail?`. */
function optionalClause(entry: CatalogEntry): string {
  const names = entry.args.filter((arg) => !arg.required).map((arg) => arg.name)
  return names.length ? ` — ${names.join("?, ")}?` : ""
}

/**
 * The `kanban_write` tool description, derived.
 *
 * Generated from the catalogue rather than written out, so a new op shows up in
 * the schema by existing — the description cannot fall behind the implementation,
 * which is the whole failure this file was written to fix.
 */
export function writeDescription(): string {
  const lines: string[] = [
    "Mutate the kanban board for this session. One operation per call.",
    "",
  ]
  const column = Math.max(...publicEntries().map((entry) => signature(entry).length))
  for (const entry of publicEntries()) {
    // trimEnd matters: padEnd leaves the shorter signatures with trailing
    // spaces, and this whole block goes into a tool description that gets
    // diffed and read by people debugging prompts.
    lines.push(`  ${signature(entry).padEnd(column)}${optionalClause(entry)}`.trimEnd())
    lines.push(`      ${entry.summary}`)
    lines.push(`      USE IT WHEN: ${entry.purpose}`)
  }
  lines.push("")
  lines.push(`  read the board with kanban_read; uncertain about an op? call kanban_help.`)
  lines.push("  Marking an item done resets the nudge counter automatically.")
  lines.push("  Never use nudge, count or pause to work around a problem — they are the human's controls.")
  return lines.join("\n")
}

/** The opening brief: the rules a cold session needs before it starts. */
function briefing(): string[] {
  return [
    "# Kanban — what this is",
    "",
    "A task board for one session, plus a restart policy that nudges a stalled",
    "agent. Two tools do the work — `kanban_read` and `kanban_write` — and a",
    "third, `kanban_help`, is this document. You are reading it now, which",
    "means you can drive everything the human can.",
    "",
    "## The loop",
    "",
    "1. `kanban_read()` — what is outstanding, and what is current.",
    "2. Work ONE item. Not all of them; the board is a queue, not a to-do list",
    "   you have to empty in one turn.",
    "3. `kanban_write({ op: 'update', id, status: 'done' })` when it is genuinely",
    "   finished — done means finished, not started, not nearly done.",
    "4. Re-read if the plan turned out to be wrong.",
    "",
    "## Rules that are not obvious",
    "",
    "- A folder is a CONTAINER, not a unit of work. You cannot mark one done;",
    "  it closes by itself when every descendant is done. Filing your work under",
    "  a folder is how you show shape, not how you finish it.",
    "- Nesting has no depth limit. A folder can hold a folder.",
    "- Marking something done resets the nudge counter. That is the counter's",
    "  meaning: evidence of progress. Done it to silence a nudge and the next",
    "  nudge comes just as fast.",
    "- `nudge`, `count`, `pause` and `debug` are the human's controls. Do not",
    "  reach for them to get unstuck. Getting stuck is information, and the",
    "  person reading this board is the one who acts on it.",
    "- Prefer the batch calls (`addMany`, `updateMany`, `removeMany`,",
    "  `moveMany`) over N single calls. They are one round trip and they are",
    "  validated as a unit, so a bad entry cannot half-apply.",
    "",
    "## Identifiers",
    "",
    "`k1`, `k2`, … assigned in order, never reused within a board. Ids are",
    "stable: reparenting keeps them, so anything you said about k7 stays about",
    "k7.",
  ]
}

/**
 * Escape a value for a markdown table cell.
 *
 * The `status` union is literally `"pending" | "in_progress" | …`, and those
 * pipes are cell separators. Left raw it splits one argument into four columns
 * and the table — the part meant to make the arguments scannable — becomes the
 * least readable thing in the document.
 */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|")
}

/** The full agent-facing document, as `kanban_help` returns it. */
export function agentHelp(): string {
  const lines: string[] = [...briefing(), "", "# Operations", ""]
  for (const entry of publicEntries()) {
    lines.push(`## kanban_write: ${entry.op}${optionalClause(entry)}`, "")
    lines.push(`**${entry.summary}**`, "")
    lines.push(`Use it when: ${entry.purpose}`, "")
    if (entry.args.length) {
      lines.push("| argument | type | meaning |", "| --- | --- | --- |")
      for (const arg of entry.args) {
        const name = arg.required ? `\`${arg.name}\`` : `\`${arg.name}\`?`
        lines.push(`| ${name} | \`${cell(arg.type)}\` | ${cell(arg.meaning)} |`)
      }
      lines.push("")
    }
    lines.push("```", entry.example, "```")
    if (entry.notes?.length) {
      lines.push("")
      for (const note of entry.notes) lines.push(`- ${note}`)
    }
    if (entry.destructive) lines.push("- Deletes work. There is no undo.")
    lines.push("")
  }

  lines.push("## kanban_read", "", `**${READ_ENTRY.summary}**`, "", `Use it when: ${READ_ENTRY.purpose}`, "")
  for (const note of READ_ENTRY.notes ?? []) lines.push(`- ${note}`)
  lines.push("")
  lines.push("## kanban_help", "", `**${HELP_ENTRY.summary}**`, "", `Use it when: ${HELP_ENTRY.purpose}`, "")

  lines.push("# For a human", "")
  lines.push(`Every one of these has a slash equivalent behind \`/${DEFAULT_ROOT}\`, so the board is`)
  lines.push("never something only you can operate. Examples:")
  lines.push("")
  lines.push(`\`\`\`
/${DEFAULT_ROOT} help                 this document, for the human
/${DEFAULT_ROOT} add k3 "a subtask"   file a task under folder k3
/${DEFAULT_ROOT} done k5              mark done, and reset the try counter
/${DEFAULT_ROOT} control              the stop / resume menu
\`\`\``)
  lines.push("")
  lines.push(`Debug log, when debugging is on: \`${DEBUG_LOG}\``)
  return lines.join("\n")
}

/**
 * `/ock help` — the catalogue as a picker.
 *
 * This was a `dialog.alert` with the whole thing rendered as one block of text,
 * and that was wrong in a way only a human could have told me: a dialog is a
 * fixed height, the text overflowed it, and the buttons that close it ended up
 * somewhere below the bottom edge. A reference you cannot close with the mouse
 * is not a reference, however good the text in it is.
 *
 * So it is a list, one row per operation, each carrying its own "use it when".
 * The dialog scrolls because that is what a list dialog does, so the buttons
 * stay put however long the catalogue gets, and the operation you are reading
 * about is on screen rather than six lines away in a paragraph.
 *
 * Order is the working loop rather than alphabetical, because that is the order
 * somebody actually wants: plan the work, work through it, prune it, back it up,
 * then the controls.
 */
export type HelpOption = { title: string; description: string; value: string }

export function humanOptions(): HelpOption[] {
  return GROUPS.flatMap((group) =>
    group.entries.map((entry) => ({
      value: entry.op,
      title: `${entry.op}${optionalClause(entry)}  ${entry.summary}`,
      description: entry.purpose,
    })),
  )
}

/** The verbs, for the panel and the tests: what `/ock <this>` does. */
export function humanVerbs(): string[] {
  return GROUPS.flatMap((group) => group.entries.map((entry) => entry.op))
}
