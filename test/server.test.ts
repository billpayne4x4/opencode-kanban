import { strict as assert } from "node:assert"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

/**
 * Server plugin, driven through a stub context.
 *
 * The stub implements only the four surfaces the plugin touches — `location`,
 * `options`, `tool.transform`, `session.hook`/`session.synthetic`, and
 * `event.subscribe` — so a failure points at plugin logic rather than at mock
 * plumbing. Tools are driven through the real editor the host builds, which is
 * the same path the model hits.
 */

type AnyRecord = Record<string, any>

type Harness = {
  tools: Record<string, AnyRecord>
  synthetic: { sessionID: string; text: string; resume?: boolean; description?: string }[]
  promptHook: ((event: AnyRecord) => Promise<void>) | undefined
  emit: (event: unknown) => Promise<void>
  finish: () => Promise<void>
  cleanup: () => Promise<void> | void
  worktree: string
  sentinels: unknown[]
}

async function load(options?: AnyRecord): Promise<Harness> {
  const plugin = (await import("../src/index.ts")).default
  const worktree = await mkdtemp(path.join(tmpdir(), "kanban-server-"))
  const synthetic: Harness["synthetic"] = []
  const sentinels: unknown[] = []

  // A push-based async queue, so an event emitted after setup is still
  // consumed — the real subscription is long-lived, unlike a drained list.
  const pending: unknown[] = []
  const waiting: ((value: IteratorResult<unknown>) => void)[] = []

  let tools: Record<string, AnyRecord> = {}
  let promptHook: ((event: AnyRecord) => Promise<void>) | undefined
  let cleanup: (() => Promise<void> | void) | undefined

  const context = {
    location: { directory: worktree },
    options: { idleConfirmMs: 0, ...options },
    tool: {
      transform: async (fn: (editor: AnyRecord) => void) => {
        fn({
          add: (tool: AnyRecord) => {
            tools[tool.name] = tool
          },
          list: () => [],
          get: () => undefined,
          namespace: () => {},
          update: () => {},
          remove: () => {},
        })
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    session: {
      hook: async (name: string, fn: (event: AnyRecord) => Promise<void>) => {
        if (name === "prompt") promptHook = fn
        return { dispose: async () => {} }
      },
      synthetic: async (input: AnyRecord) => {
        synthetic.push(input as Harness["synthetic"][number])
        return {}
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        sentinels.push(signal)
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (signal.aborted) return Promise.resolve({ value: undefined, done: true })
              if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false })
              return new Promise<IteratorResult<unknown>>((resolve) => waiting.push(resolve))
            },
            return: () => Promise.resolve({ value: undefined, done: true }),
          }),
        }
      },
    },
  }

  const definition = plugin as AnyRecord
  cleanup = await definition.setup(context)

  return {
    tools,
    synthetic,
    sentinels,
    worktree,
    get promptHook() {
      return promptHook
    },
    emit: async (event) => {
      const waiter = waiting.shift()
      if (waiter) waiter({ value: event, done: false })
      else pending.push(event)
    },
    finish: () => new Promise((resolve) => setTimeout(resolve, 10)),
    cleanup: () => cleanup?.(),
  }
}

function context(sessionID = "ses_test") {
  return { sessionID, signal: new AbortController().signal, progress: async () => {} }
}

const idle = (sessionID = "ses_test") => ({ type: "session.idle", data: { sessionID } })
const deleted = (sessionID = "ses_test") => ({ type: "session.deleted", data: { sessionID } })

/** Read the persisted nudge state straight off disk. */
async function nudgeState(worktree: string, sessionID = "ses_test") {
  const raw = JSON.parse(await readFile(path.join(worktree, ".opencode", "kanban.json"), "utf8"))
  return raw.boards[sessionID]?.nudge
}

describe("tool registration", () => {
  it("registers the two board tools plus the catalogue, with JSON Schema input", async () => {
    const { tools } = await load()
    // Three, not two: the third is documentation. A new session that cannot
    // find out what `moveMany` is for will simply never call it, and the tool
    // exists to stop that. The count is asserted so adding a fourth is a
    // deliberate act rather than an accident.
    assert.deepEqual(Object.keys(tools).sort(), ["kanban_help", "kanban_read", "kanban_write"])
    for (const definition of Object.values(tools)) {
      assert.ok(definition.description.length > 20, "a model needs a real description")
      assert.equal(typeof definition.execute, "function")
      assert.equal(definition.input.type, "object")
    }
    assert.deepEqual(Object.keys(tools.kanban_write.input.properties).sort(), [
      "content",
      "detail",
      "enabled",
      "id",
      "ids",
      "items",
      "maxAttempts",
      "merge",
      "mode",
      "op",
      "parentID",
      "path",
      "status",
      "title",
      "to",
    ])
    // The op enum and the human-facing description must agree, or a model
    // discovers half the surface only by trial and error.
    assert.deepEqual(tools.kanban_write.input.properties.op.enum, [
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
    ])
  })

  it("describes every op in the write description so the model does not guess", async () => {
    const { tools } = await load()
    for (const op of ["add", "update", "remove", "move", "current", "clear", "pause", "resume", "unpause"]) {
      assert.ok(tools.kanban_write.description.includes(op), `write description should mention \`${op}\``)
    }
  })
})

describe("kanban_read", () => {
  it("reports an empty board helpfully", async () => {
    const { tools } = await load()
    const result = await tools.kanban_read.execute({}, context())
    assert.match(result.content, /Board is empty/)
    assert.match(result.content, /nudge: no nudges yet/)
  })

  it("reports items the agent wrote, with detail", async () => {
    const { tools } = await load()
    await tools.kanban_write.execute(
      { op: "add", title: "Fix lowering", detail: "no library names" },
      context(),
    )
    const result = await tools.kanban_read.execute({}, context())
    assert.match(result.content, /k1 · Fix lowering/)
    assert.match(result.content, /detail: no library names/)
    assert.match(result.content, /0\/1 done/)
  })

  it("is scoped to the session in context", async () => {
    const { tools } = await load()
    await tools.kanban_write.execute({ op: "add", title: "mine" }, context("ses_a"))
    await tools.kanban_write.execute({ op: "add", title: "theirs" }, context("ses_b"))
    const a = await tools.kanban_read.execute({}, context("ses_a"))
    assert.match(a.content, /mine/)
    assert.doesNotMatch(a.content, /theirs/)
  })
})

describe("kanban_write", () => {
  it("returns the updated board so the agent sees the effect", async () => {
    const { tools } = await load()
    const result = await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    assert.match(result.content, /added k1: a/)
    assert.match(result.content, /0\/1 done/)
  })

  it("reports a bad mutation as a recoverable message, not a throw", async () => {
    const { tools } = await load()
    const result = await tools.kanban_write.execute({ op: "remove", id: "k9" }, context())
    assert.match(result.content, /rejected: no item k9/)
    assert.match(result.content, /Valid ops/)
  })

  it("resets the nudge counter when work is completed", async () => {
    const { tools } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await tools.kanban_write.execute({ op: "update", id: "k1", status: "done" }, context())
    const result = await tools.kanban_read.execute({}, context())
    assert.match(result.content, /nudge: no nudges yet/)
    assert.match(result.content, /1\/1 done/)
  })
})

describe("the idle nudge", () => {
  it("does nothing on an empty board", async () => {
    const { tools, emit, finish, synthetic } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await tools.kanban_write.execute({ op: "clear" }, context())
    await emit(idle())
    await finish()
    assert.deepEqual(synthetic, [])
  })

  it("nudges once with a bare task id, and resumes the agent", async () => {
    const { tools, emit, finish, synthetic } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await emit(idle())
    await finish()
    assert.equal(synthetic.length, 1)
    assert.match(synthetic[0].text, /^kanban k1 \| try 1\/3 \| \d+ open \| 2 tries left$/)
    assert.equal(synthetic[0].sessionID, "ses_test")
    assert.equal(synthetic[0].resume, true, "a nudge must restart the agent loop")
  })

  it("nudges three times then stops", async () => {
    const { tools, emit, finish, synthetic, worktree } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    for (let i = 0; i < 6; i += 1) {
      await emit(idle())
      await finish()
    }
    assert.equal(synthetic.length, 3, "three tries, then assume the human meant stop")
    assert.equal((await nudgeState(worktree)).halted, true)
  })

  it("respects a pause", async () => {
    const { tools, emit, finish, synthetic } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await tools.kanban_write.execute({ op: "pause" }, context())
    for (let i = 0; i < 4; i += 1) {
      await emit(idle())
      await finish()
    }
    assert.deepEqual(synthetic, [])
  })

  it("does not interrupt a human who is typing", async () => {
    const { tools, emit, finish, synthetic } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await tools.kanban_write.execute({ op: "composer", busy: true }, context())
    await emit(idle())
    await finish()
    assert.deepEqual(synthetic, [], "the composer flag must veto the nudge")
  })

  it("honours a custom attempt budget", async () => {
    const { tools, emit, finish, synthetic } = await load({ maxAttempts: 1 })
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    for (let i = 0; i < 3; i += 1) {
      await emit(idle())
      await finish()
    }
    assert.equal(synthetic.length, 1)
  })

  it("can be switched off entirely", async () => {
    const { tools, emit, finish, synthetic } = await load({ nudge: false })
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    for (let i = 0; i < 4; i += 1) {
      await emit(idle())
      await finish()
    }
    assert.deepEqual(synthetic, [], "tools still work, the restart policy is off")
  })

  it("ignores unrelated events", async () => {
    const { tools, emit, finish, synthetic } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await emit({ type: "session.status", data: { sessionID: "ses_test", status: { type: "busy" } } })
    await finish()
    assert.deepEqual(synthetic, [])
  })

  it("forgets the board when a session is deleted", async () => {
    const { tools, emit, finish, worktree } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await emit(deleted())
    await finish()
    const persisted = JSON.parse(await readFile(path.join(worktree, ".opencode", "kanban.json"), "utf8"))
    assert.equal(persisted.boards.ses_test, undefined)
  })

  it("aborts the event subscription on cleanup", async () => {
    const { tools, sentinels, cleanup } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    assert.equal(sentinels.length, 1, "one subscription per plugin")
    assert.equal((sentinels[0] as AbortSignal).aborted, false)
    await cleanup()
    assert.equal((sentinels[0] as AbortSignal).aborted, true, "cleanup must stop the stream")
  })
})

describe("the human-message guard", () => {
  /** Fire the registered `prompt` hook the way the host would. */
  async function humanSays(hook: unknown, sessionID = "ses_test") {
    await (hook as (event: AnyRecord) => Promise<void>)({ sessionID, prompt: { parts: [] } })
  }

  it("stays quiet right after the human speaks", async () => {
    const { tools, emit, finish, synthetic, promptHook } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    await humanSays(promptHook)
    await emit(idle())
    await finish()
    assert.deepEqual(synthetic, [], "a human mid-sentence must not be nudged over")
  })

  it("resets the counter, so the budget is per burst of human turns", async () => {
    const { tools, emit, finish, synthetic, promptHook, worktree } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context())
    for (let i = 0; i < 2; i += 1) {
      await emit(idle())
      await finish()
    }
    assert.equal(synthetic.length, 2)
    await humanSays(promptHook)
    assert.equal((await nudgeState(worktree)).attempts, 0)
  })

  it("tracks the human per session", async () => {
    const { tools, emit, finish, synthetic, promptHook } = await load()
    await tools.kanban_write.execute({ op: "add", title: "a" }, context("ses_a"))
    await tools.kanban_write.execute({ op: "add", title: "b" }, context("ses_b"))
    await humanSays(promptHook, "ses_a")
    await emit(idle("ses_a"))
    await finish()
    await emit(idle("ses_b"))
    await finish()
    assert.deepEqual(synthetic.map((entry) => entry.sessionID), ["ses_b"], "only the quiet session is nudged")
  })
})