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
import { type Mutation, type Store, apply, parseMutation } from "./actions.ts"
import { DEFAULT_MAX_ATTEMPTS, decideNudge, nudgeLabel, nudgeText } from "./nudge.ts"
import * as store from "./store.ts"

const PLUGIN_ID = "opencode-kanban"

/**
 * How long after a human message we stay quiet.
 *
 * The race we are avoiding: a human sends something, the turn fails or ends
 * instantly, `session.idle` fires, and we nudge straight over the top of a
 * message they are still typing. A real turn takes far longer than this, so
 * the window costs almost nothing and removes the case that actually annoys.
 */
export const HUMAN_GRACE_MS = 5000

type Options = {
  maxAttempts?: number
  /** Set false to keep the tools and panel but never restart the agent. */
  nudge?: boolean
}

function resolveOptions(raw: unknown): Required<Options> {
  const options = (typeof raw === "object" && raw !== null ? raw : {}) as Options
  const max =
    typeof options.maxAttempts === "number" && options.maxAttempts >= 1
      ? Math.trunc(options.maxAttempts)
      : DEFAULT_MAX_ATTEMPTS
  return { maxAttempts: max, nudge: options.nudge !== false }
}

const MUTATION_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["add", "update", "remove", "move", "current", "clear", "pause", "resume", "unpause"],
      description: "The operation to perform",
    },
    title: { type: "string", description: "For add/update: the task title" },
    detail: { type: "string", description: "For add/update: acceptance criteria, procedure, links" },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "done", "blocked"],
      description: "For add/update",
    },
    id: { type: "string", description: "For update/remove/move/current: which item" },
    to: { type: "number", description: "For move: the destination index" },
  },
  required: ["op"],
  additionalProperties: false,
} as const

const WRITE_DESCRIPTION = [
  "Mutate the kanban board for this session. One operation per call.",
  "  add      title, detail?, status?",
  "  update   id, title?/detail?/status?",
  "  remove   id",
  "  move     id, to (index)",
  "  current  id?   (omit to clear)",
  "  clear | pause | resume | unpause",
  "Marking an item done resets the nudge counter automatically.",
].join("\n")

const READ_DESCRIPTION = [
  "Read the kanban board for this session: every item with status and detail,",
  "which item is current, progress counters, and the nudge/retry state.",
  "Call this at the start of a turn to see outstanding work, or whenever you",
  "need an item's acceptance criteria. Read-only.",
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

    const io: Store = {
      read: (sessionID) => store.load(worktree, sessionID),
      write: (board) => store.save(worktree, board),
    }

    function log(message: string) {
      console.error(`[${PLUGIN_ID}] ${message}`)
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "kanban_read",
        description: READ_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(input, context) {
          const board = await io.read(context.sessionID)
          return {
            content: `${renderBoard(board, options.maxAttempts)}\n\n(nudging: ${nudgeLabel(board.nudge, options.maxAttempts)})`,
          }
        },
      })

      editor.add({
        name: "kanban_write",
        description: WRITE_DESCRIPTION,
        input: MUTATION_SCHEMA,
        async execute(input, context) {
          const mutation: Mutation = parseMutation(input)
          try {
            const { board, message } = await apply(io, context.sessionID, mutation)
            return { content: `${message}\n\n${renderBoard(board, options.maxAttempts)}` }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
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

    await ctx.session.hook("prompt", async (event) => {
      lastHumanMessageAt.set(event.sessionID, Date.now())
      try {
        const board = await io.read(event.sessionID)
        // A human talking is not "work completed", so a halt they set stays.
        if (board.nudge.attempts === 0 && !board.nudge.halted) return
        await io.write({
          ...board,
          nudge: { ...board.nudge, attempts: 0, lastResult: "you spoke — counter reset" },
          updatedAt: Date.now(),
        })
      } catch (error) {
        log(`failed to reset nudge counter for ${event.sessionID}: ${String(error)}`)
      }
    })

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") {
            await store
              .forget(worktree, event.data.sessionID)
              .catch((error) => log(`failed to forget board for deleted session: ${String(error)}`))
            continue
          }

          if (event.type !== "session.idle" || !options.nudge) continue

          // v2 event payloads live on `data`; v1 used `properties`.
          const sessionID = event.data.sessionID
          const spoke = lastHumanMessageAt.get(sessionID)
          if (spoke !== undefined && Date.now() - spoke < HUMAN_GRACE_MS) continue

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

          if (!decision.fire || !decision.item) continue
          try {
            await ctx.session.synthetic({
              sessionID,
              text: nudgeText(decision.item),
              description: `kanban nudge ${decision.nudge.attempts}/${options.maxAttempts}`,
              resume: true,
            })
          } catch (error) {
            // A failed nudge must never take the plugin down; the next idle
            // event tries again and the counter bounds how often that is.
            log(`nudge to ${sessionID} failed: ${String(error)}`)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event stream ended: ${String(error)}`)
      }
    })()

    return () => controller.abort()
  },
})