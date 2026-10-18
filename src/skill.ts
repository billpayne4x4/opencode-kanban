/**
 * The skill that tells a model this board exists.
 *
 * ## Why this file exists
 *
 * Until it did, the plugin's entire surface to a model was its tool
 * descriptions plus `kanban_help` — a door you have to already know is there.
 * An agent that had not gone looking would never call `kanban_read`, never see
 * the board, and never learn that anyone made one. The observable result was an
 * agent asked to track its work hand-editing a scratch file instead, while a
 * purpose-built board sat unused in the same session.
 *
 * v2 skills can be *embedded*, which means a plugin ships its own with no
 * directory to configure and nothing for a human to remember. `autoinvoke`
 * decides how loudly it introduces itself:
 *
 * - `true`  — the content is injected into context, so the model knows the board
 *             is there without asking. Costs tokens every turn.
 * - `false` — the skill is listed but not inlined; the model pulls it if it
 *             decides the board is relevant.
 *
 * This one is `true`. The failure it prevents is silent: an agent that does not
 * know about the board produces no error, no warning, just work tracked in the
 * wrong place. Paying a few hundred tokens a turn to remove that is the right
 * trade for a board whose entire job is being found.
 */

export const SKILL_ID = "kanban-board"
export const SKILL_NAME = "kanban-board"
export const SKILL_DESCRIPTION = "This session has a durable task board. Read it first, every turn."

/**
 * What the model is told.
 *
 * Kept to the rules that are not guessable from a tool signature. Anything
 * derivable by reading `kanban_help` is left out — the point is to teach the
 * habit, not to restate the schema.
 */
export const SKILL_CONTENT = `# Session task board

This session has a durable task board. It is the place work is tracked.

## Read it before you decide what to do

Call \`kanban_read\` at the START of every turn. It is the only way to see what
is outstanding, what is current, and how many nudges are left.

Do not keep a plan in your head, and do not hand-edit a task list or a scratch
file to track work — if you are about to write one by hand, you are duplicating
a board that already exists. Ask for it first.

## Write as you go

\`kanban_write\` takes an \`op\`. The ones that matter day to day:

- \`{op:"add", title}\` — one task
- \`{op:"addMany", items:[{title, detail}]}\` — a batch, when planning up front
- \`{op:"update", id, status:"in_progress"}\` — start one
- \`{op:"update", id, status:"done"}\` — finish one
- \`{op:"subtasks", parentID, items:[...]}\` — break a task into steps
- \`{op:"folder", title}\` — a container; it closes itself once its leaves are done

\`kanban_help\` lists every op with its arguments and an example.

## The rule that surprises people

**Marking something done RESETS the nudge counter.** Finishing work is what
clearing the counter means. Do it to silence a nudge and the next nudge comes
just as fast.

## Nudges

If the session goes quiet with work outstanding, the board nudges the agent back
up to three times, then halts and waits for a human. A message reading
\`kanban k12 | try 2/3\` means work was left open and the session went quiet.

\`{op:"pause"}\` stops nudging. \`{op:"resume"}\` clears a halt and zeroes the
counter. \`nudge\`, \`count\`, \`pause\` and \`debug\` are the human's controls —
leave them alone unless a human asks.

## Keeping a copy

- \`{op:"export"}\` writes \`.ai/tasks.md\` as an indented checklist
- \`{op:"import", path:"..."}\` reads one back; \`merge:false\` replaces
`