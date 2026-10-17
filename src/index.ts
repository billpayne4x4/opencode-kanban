/**
 * Server plugin: the agent's half of the board.
 *
 * OpenCode 2 plugin shape — `Plugin.define({ id, setup(ctx) })`, which is not
 * interchangeable with the v1 `Plugin` function that returned a hooks object.
 * A v1 implementation silently does not run in v2, so this file is the v2 API
 * throughout:
 *
 * - tools       `ctx.tool.transform((editor) => editor.add(...))`, JSON Schema
 *               input, structured `{ content }` result
 * - events      `ctx.event.subscribe({ signal })`, an async iterator
 * - nudging     `ctx.session.synthetic(...)`, which injects a synthetic user
 *               message and can resume the agent loop — the right primitive
 *               for "the agent stalled, carry on", and visibly not a human
 *               message
 * - a human speaking  `ctx.session.hook("prompt", ...)`
 *
 * Board state is a file under the worktree rather than `ctx.storage`, because
 * the sidebar half of this plugin is a separate plugin context in a separate
 * process and both halves must see the same board. See README.
 */

import { Plugin } from "@opencode/plugin"
import { renderBoard } from "./format.ts"
import { agentHelp, writeDescription } from "./catalog.ts"
import { type Mutation, type Store, apply, parseMutation } from "./actions.ts"
import { DEFAULT_MAX_ATTEMPTS, boardStatus, decideNudge, maxAttemptsFor, nudgeLabel, nudgeText, openWork } from "./nudge.ts"
import * as store from "./store.ts"
import { projectFiles } from "./files.ts"
import { DEBUG_LOG, debug, debugAlways } from "./debug.ts"

const PLUGIN_ID = "opencode-kanban"

/**
 * Process-wide handle on the one live event loop.
 *
 * Hot reload re-runs `setup` without reliably running the previous instance's
 * cleanup, so each reload left another `event.subscribe` loop alive. Three
 * reloads meant every `session.idle` was handled three times — which would
 * triple-increment the attempt counter and halt the nudge after roughly one
 * try instead of three.
 *
 * The handle hangs off `globalThis` rather than module scope on purpose: module
 * state is discarded when the entrypoint is re-imported, so it cannot see the
 * previous loop. `globalThis` survives that, which is the whole point.
 */
const LOOP_KEY = "__opencodeKanbanEventLoop"
type LoopHandle = { controller: AbortController }
const shared = globalThis as unknown as Record<string, LoopHandle | undefined>

function takeOverEventLoop(): AbortController {
  const previous = shared[LOOP_KEY]
  if (previous) previous.controller.abort()
  const controller = new AbortController()
  shared[LOOP_KEY] = { controller }
  return controller
}

/**
 * How long after a human message we stay quiet.
 *
 * The race we are avoiding: a human sends something, the turn fails or ends
 * instantly, `session.idle` fires, and we nudge straight over the top of a
 * message they are still typing. A real turn takes far longer than this, so
 * the window costs almost nothing and removes the case that actually annoys.
 */
export const HUMAN_GRACE_MS = 5000

/**
 * How recently the host must have stamped `session.time.idle` before a
 * `session.step.ended` counts as a real end-of-turn, and the window in which a
 * second trigger for the same idle is ignored.
 */
export const IDLE_CONFIRM_MS = 4000

type Options = {
  maxAttempts?: number
  /** Set false to keep the tools and panel but never restart the agent. */
  nudge?: boolean
  /**
   * Window in which a second idle trigger for the same moment is ignored.
   * 0 disables the collapse, which is what the tests want when they fire
   * several idles back to back to simulate several nudges.
   */
  idleConfirmMs?: number
  /**
   * Where changes are announced: `"panel"` is a coloured block in the window,
   * `"toast"` is the host's own notification.
   *
   * This is only the *starting* value — `kanban_write({op:"notify"})` and
   * `/ock notify` change it for the session and that choice wins, because
   * options are read once at load and nobody wants to edit a config file to
   * turn a colour off.
   */
  notify?: "toast" | "panel"
}

function resolveOptions(raw: unknown): Required<Options> {
  const options = (typeof raw === "object" && raw !== null ? raw : {}) as Options
  const max =
    typeof options.maxAttempts === "number" && options.maxAttempts >= 1
      ? Math.trunc(options.maxAttempts)
      : DEFAULT_MAX_ATTEMPTS
  const idleConfirmMs =
    typeof options.idleConfirmMs === "number" && options.idleConfirmMs >= 0
      ? Math.trunc(options.idleConfirmMs)
      : IDLE_CONFIRM_MS
  const notify = options.notify === "toast" ? "toast" : "panel"
  return { maxAttempts: max, nudge: options.nudge !== false, idleConfirmMs, notify }
}

const MUTATION_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: [
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
      ],
      description: "The operation to perform",
    },
    title: { type: "string", description: "For add/update: the task title" },
    detail: { type: "string", description: "For add/update: acceptance criteria, procedure, links" },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "done", "blocked"],
      description: "For add/update",
    },
    id: { type: "string", description: "For update/remove/move/current/reparent: which item" },
    parentID: {
      type: "string",
      description:
        "For subtask/subtasks/reparent: the folder to nest under (empty string = top level). " +
        "A parent is a container, not a unit of work: it closes automatically once every subtask closes.",
    },
    to: {
      type: "number",
      description: "For move: the destination index. For moveMany: one index for the whole batch (0 = the very top, -1 = the end); the ids keep the order you give them.",
    },
    enabled: {
      type: "boolean",
      description:
        "For nudge: turn the restart policy on or off (off keeps the board but never restarts you). " +
        "For debug: write a full activity log to /tmp/opencode-kanban-debug.log",
    },
    maxAttempts: {
      type: "number",
      description: "For count: how many nudges before halting (1-9999). Resets the counter",
    },
    ids: {
      type: "array",
      description: "For removeMany: the whole batch of ids. Removes many tasks in one call instead of N.",
      maxItems: 500,
      items: { type: "string" },
    },
    path: {
      type: "string",
      description:
        "For export/template: where to write, relative to the project root (default .ai/tasks.md and " +
        ".ai/tasks.template.md). For import: the checklist to read. Must stay inside the project — " +
        "a path that climbs out with ../ is refused.",
    },
    content: {
      type: "string",
      description:
        "For import: the checklist itself, when you already have the text. Skips the filesystem, so " +
        "pass either `path` or `content`, never neither.",
    },
    merge: {
      type: "boolean",
      description:
        "For import: true (default) adds the file's tasks to the board; false replaces the board with it, " +
        "which is the restore path and the only one that can lose what is already here.",
    },
    mode: {
      type: "string",
      enum: ["toast", "panel"],
      description: "For notify: where changes are announced — 'panel' is a coloured block in the window, 'toast' is the host's own notification.",
    },
    items: {
      type: "array",
      description:
        "For addMany: the whole batch. PREFER THIS over repeated `add` calls when you already know the plan — " +
        "one call instead of N, and the batch is validated before anything is written so a bad entry cannot " +
        "leave a half-built board.",
      maxItems: 500,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  required: ["op"],
  additionalProperties: false,
} as const

const WRITE_DESCRIPTION = writeDescription()

const READ_DESCRIPTION = [
  "Read the kanban board for this session: every item with status and detail,",
  "which item is current, progress counters, and the nudge/retry state.",
  "Call this at the start of a turn to see outstanding work, or whenever you",
  "need an item's acceptance criteria. Read-only.",
  "Not sure what an operation does? Call kanban_help for the full catalogue.",
].join(" ")

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = resolveOptions(ctx.options)
    const worktree = ctx.location.directory

    // One line on load. A plugin that silently fails to attach is the most
    // confusing thing a plugin can do, and this is the cheapest confirmation
    // that an install worked.
    console.error(
      `[${PLUGIN_ID}] loaded — nudging up to ${options.maxAttempts}x${options.nudge ? "" : " (disabled)"} on ${worktree}`,
    )

    debugAlways("state", `attached; log=${DEBUG_LOG}; maxAttempts=${options.maxAttempts}; nudge=${options.nudge}`)

    const io: Store = {
      read: (sessionID) => store.load(worktree, sessionID),
      write: (board) => store.save(worktree, board),
      files: projectFiles(worktree),
    }

    function log(message: string) {
      console.error(`[${PLUGIN_ID}] ${message}`)
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        /**
         * The catalogue, as a tool.
         *
         * A new session knows two tool names and nothing else. Without this
         * it either guesses what twenty-two `op` values mean, or — worse —
         * uses the handful it recognises and silently ignores the rest. The
         * description is generated in `catalog.ts` from the same table that
         * documents them, so the two cannot drift apart.
         */
        name: "kanban_help",
        description: [
          "Full documentation for the kanban board: every operation kanban_write accepts,",
          "what each one is FOR, its arguments, and a copyable example.",
          "Call this when you are unsure what an op does, or what this board can do at all.",
          "Read-only, costs nothing, and never touches the board.",
        ].join(" "),
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          debugAlways("tool", `kanban_help session=${context.sessionID}`)
          return { content: agentHelp() }
        },
      })

      editor.add({
        name: "kanban_read",
        description: READ_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(input, context) {
          const board = await io.read(context.sessionID)
          debug(board, "tool", `kanban_read session=${context.sessionID} items=${board.items.length}`)
          return {
            content: `status: ${boardStatus(board)}\n${renderBoard(board, options.maxAttempts)}\n\n(nudge: ${nudgeLabel(board.nudge, options.maxAttempts)})`,
          }
        },
      })

      editor.add({
        name: "kanban_write",
        description: WRITE_DESCRIPTION,
        input: MUTATION_SCHEMA,
        async execute(input, context) {
          const mutation: Mutation = parseMutation(input)
          const before = await io.read(context.sessionID)
          try {
            const { board, message } = await apply(io, context.sessionID, mutation)
            debug(
              board,
              mutation.op === "debug" || mutation.op === "nudge" || mutation.op === "count" ? "state" : "tool",
              `kanban_write ${mutation.op} -> ${message} (${board.items.length} items, nudge=${JSON.stringify(board.nudge)})`,
            )
            return { content: `${message}\n\n${renderBoard(board, options.maxAttempts)}` }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            debug(before, "error", `kanban_write ${mutation.op} rejected: ${detail}`)
            // A rejected mutation is not a crash. Say what was wrong and what
            // the valid shape is, so the next call is more likely to land.
            return {
              content:
                `kanban_write rejected: ${detail}\n` +
                `Valid ops: add, update, remove, move, current, clear, pause, resume, unpause.`,
            }
          }
        },
      })
    })

    /**
     * When a human last spoke, per session.
     *
     * The guard against interrupting someone who is driving. Built from what
     * the v2 API exposes — user prompts and session status — because the
     * composer box itself is not observable: slot mode is append/replace/
     * single-winner, so there is no way to watch the input without taking it.
     */
    const lastHumanMessageAt = new Map<string, number>()

    /** When we last acted on an idle for a session, to collapse double triggers. */
    const lastIdleHandledAt = new Map<string, number>()

    await ctx.session.hook("prompt", async (event) => {
      lastHumanMessageAt.set(event.sessionID, Date.now())
      debug(await io.read(event.sessionID).catch(() => undefined), "event", "human message -> grace window opens")
      try {
        const board = await io.read(event.sessionID)
        // Speaking to the agent re-engages it, so this clears the halt as well
        // as the counter. Zeroing attempts while leaving `halted` true was
        // producing "halted with nothing spent" — a state that reads as an
        // error in red when the budget is in fact untouched.
        if (board.nudge.attempts === 0 && !board.nudge.halted) return
        await io.write({
          ...board,
          nudge: { ...board.nudge, attempts: 0, halted: false, lastResult: "you spoke — counter and halt cleared" },
          updatedAt: Date.now(),
        })
      } catch (error) {
        log(`failed to reset nudge counter for ${event.sessionID}: ${String(error)}`)
      }
    })

    const controller = takeOverEventLoop()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") {
            await store
              .forget(worktree, event.data.sessionID)
              .catch((error) => log(`failed to forget board for deleted session: ${String(error)}`))
            continue
          }

          if (!options.nudge) continue

          const isIdle = event.type === "session.idle"
          const isStepEnd = event.type === "session.step.ended"
          if (!isIdle && !isStepEnd) continue

          // v2 event payloads live on `data`; v1 used `properties`.
          const sessionID = event.data.sessionID

          // `session.idle` is not emitted on every host path, so
          // `session.step.ended` is the trigger that actually fires. This used
          // to re-confirm it against `session.time.idle`, and that gate could
          // never pass: the host stamps that field once and never advances it,
          // so `Date.now() - idleAt` only ever grows. It therefore suppressed
          // every step-ended nudge and logged a "skipping nudge" line each time
          // — a check that looked load-bearing and did nothing but look
          // load-bearing. The debounce below is what actually collapses the two
          // triggers landing for one idle.
          // Both triggers can land for the same idle, so never handle one twice.
          const lastHandled = lastIdleHandledAt.get(sessionID) ?? 0
          if (options.idleConfirmMs > 0 && Date.now() - lastHandled < options.idleConfirmMs) continue
          lastIdleHandledAt.set(sessionID, Date.now())

          const spoke = lastHumanMessageAt.get(sessionID)
          if (spoke !== undefined && Date.now() - spoke < HUMAN_GRACE_MS) {
            debug(
              await io.read(sessionID).catch(() => undefined),
              "event",
              `idle confirmed but ${Math.round(HUMAN_GRACE_MS - (Date.now() - spoke))}ms left of the human grace window -> not nudging`,
            )
            continue
          }

          let decision
          try {
            const board = await io.read(sessionID)
            decision = decideNudge(board, { maxAttempts: options.maxAttempts, composerBusy: board.composerBusy })
            // Persist even when we do not fire: the counter and the halt flag
            // are the durable half of the policy and must survive a restart.
            await io.write({ ...board, nudge: decision.nudge, composerBusy: board.composerBusy })
          } catch (error) {
            log(`idle check failed for ${sessionID}: ${String(error)}`)
            continue
          }

          debug(
            await io.read(sessionID).catch(() => undefined),
            "nudge",
            `idle: ${decision.reason}${decision.fire && decision.item ? ` -> firing "${nudgeText(decision.item)}"` : " -> not firing"}`,
          )
          if (!decision.fire || !decision.item) continue
          try {
            // The board `decideNudge` already read, not three more reads.
            //
            // Re-reading here is how a nudge goes out naming work that was
            // removed a moment ago: the decision is computed, then the board is
            // re-read for the budget and the count, and anything that changed in
            // between is invisible to the text but visible to the agent. It also
            // cost two extra file reads on the one code path that has to be
            // reliable when things are going wrong.
            const current = await io.read(sessionID).catch(() => undefined)
            await ctx.session.synthetic({
              sessionID,
              text: nudgeText(
                decision.item,
                decision.nudge.attempts,
                maxAttemptsFor(current, options.maxAttempts),
                openWork(current),
              ),
              description: `kanban nudge ${decision.nudge.attempts}/${options.maxAttempts}`,
              resume: true,
            })
          } catch (error) {
            // A failed nudge must never take the plugin down; the next idle
            // event tries again and the counter bounds how often that is.
            log(`nudge to ${sessionID} failed: ${String(error)}`)
            debug(await io.read(sessionID).catch(() => undefined), "error", `synthetic failed: ${String(error)}`)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event stream ended: ${String(error)}`)
      }
    })()

    return () => {
      controller.abort()
      // Only release the handle if it is still ours: a later reload may already
      // have taken over, and clearing its handle would leave it unguarded.
      if (shared[LOOP_KEY]?.controller === controller) shared[LOOP_KEY] = undefined
    }
  },
})