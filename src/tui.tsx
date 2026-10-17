/** @jsxImportSource @opentui/solid */
/**
 * TUI plugin: the sidebar panel and the dialogs that drive it.
 *
 * OpenCode 2 shape (`Plugin.define({ id, setup(ctx) })` from
 * `@opencode/plugin/tui`). The panel goes in the `session.panel` slot, which
 * the host lays out as a right-hand pane and promotes to full screen on a
 * narrow terminal — `PanelInput.presentation` reports which, and
 * `toggleFullscreen()` switches it. Scrolling and input scope belong to the
 * host; this file supplies contents.
 *
 * The v2 dialog API is promise-based (`await ui.dialog.select(...)`), so there
 * is no dialog JSX and no manual clearing.
 */

import { watch } from "node:fs"
import path from "node:path"
import { For, Show, createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { type Board, type Item } from "./types.ts"
import { checkbox, itemLabel, panelRule, panelTitle, truncate, EMPTY_BOARD } from "./format.ts"
import { progress } from "./board.ts"
import { type Mutation, type Store, apply } from "./actions.ts"
import { nudgeLabel } from "./nudge.ts"
import { COMMANDS, HALT_HINT } from "./commands.ts"
import { STATE_DIR, STATE_FILE, load, save } from "./store.ts"

const PANEL = "kanban.board"

/** How long after a board file change we wait before re-reading it. */
const WATCH_DEBOUNCE_MS = 40

function sessionIDOf(sessionID: string | undefined): string {
  return sessionID ?? ""
}

export default Plugin.define({
  id: "opencode-kanban",
  async setup(ctx) {
    const ui = ctx.ui
    const worktree = ctx.location?.directory ?? process.cwd()

    const io: Store = {
      read: (sessionID) => load(worktree, sessionID),
      write: (board) => save(worktree, board),
    }

    const [board, setBoard] = createSignal<Board | undefined>()
    const maxAttempts = 3

    // Serialise reloads so a burst of writes cannot land out of order.
    let seq = 0
    async function refresh(sessionID: string) {
      if (!sessionID) {
        setBoard(undefined)
        return
      }
      const mine = ++seq
      try {
        const next = await io.read(sessionID)
        if (mine === seq) setBoard(next)
      } catch {
        // A transient read failure just leaves the panel on its last good view.
      }
    }

    function toast(variant: "info" | "success" | "warning" | "error", message: string) {
      ui.toast.show({ variant, message })
    }

    async function mutate(sessionID: string, mutation: Mutation, ok?: string) {
      if (!sessionID) {
        toast("error", "Kanban: open a session first")
        return
      }
      try {
        const { message } = await apply(io, sessionID, mutation)
        await refresh(sessionID)
        toast("success", ok ?? message)
      } catch (error) {
        toast("error", `Kanban: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // --- the panel -----------------------------------------------------------

    function Panel(props: { input: { sessionID: string; width: number; presentation: string } }) {
      const theme = ctx.theme.current
      const items = createMemo(() => board()?.items ?? [])
      const counts = createMemo(() => progress({ items: items() }))
      const title = createMemo(() => panelTitle(counts().done, counts().total))
      const nudge = () => board()?.nudge

      const tone = (item: Item) => {
        if (item.status === "done") return theme.textMuted
        if (item.id === board()?.currentID) return theme.accent
        if (item.status === "in_progress") return theme.info
        if (item.status === "blocked") return theme.warning
        return theme.text
      }

      return (
        <box flexDirection="column">
          <text fg={theme.text}>
            <b>{title()}</b>
          </text>
          <text fg={theme.border}>{panelRule(title())}</text>

          <Show when={items().length > 0} fallback={<text fg={theme.textMuted}>{EMPTY_BOARD}</text>}>
            <box flexDirection="column">
              <For each={items()}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <Show when={item.id === board()?.currentID}>
                      <text flexShrink={0} fg={theme.accent}>
                        {"▸"}
                      </text>
                    </Show>
                    <text flexShrink={0} fg={item.status === "done" ? theme.success : theme.textMuted}>
                      {checkbox(item.status)}
                    </text>
                    <text flexGrow={1} wrapMode="word" fg={tone(item)}>
                      {truncate(item.title, Math.max(12, props.input.width - 8))}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <Show when={nudge()}>
            {(n) => (
              <text fg={theme.textMuted}>
                {"⟳ "}
                {nudgeLabel(n(), maxAttempts)}
                <Show when={n().halted}>
                  <span style={{ fg: theme.warning }}> — {HALT_HINT}</span>
                </Show>
              </text>
            )}
          </Show>
        </box>
      )
    }

    ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL) return <box />
        return <Panel input={input} />
      },
    })

    // Keep the panel live. The server half writes the same file when the agent
    // touches the board, so watch rather than keep a private copy that drifts.
    let debounce: ReturnType<typeof setTimeout> | undefined
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(path.join(worktree, STATE_DIR), (_event, filename) => {
        if (filename !== null && filename !== STATE_FILE && !filename.startsWith(`${STATE_FILE}.`)) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => void refresh(ui.panel.current()?.sessionID ?? ""), WATCH_DEBOUNCE_MS)
      })
      watcher.on("error", () => {})
    } catch {
      // No .opencode directory yet; the server creates it on first write.
    }

    // --- dialogs -------------------------------------------------------------

    async function pickItem(title: string, placeholder: string): Promise<string | undefined> {
      const items = board()?.items ?? []
      if (items.length === 0) {
        await ui.dialog.alert({ title, message: EMPTY_BOARD })
        return undefined
      }
      return ui.dialog.select<string>({
        title,
        placeholder,
        options: items.map((item) => ({ title: itemLabel(item), value: item.id })),
      })
    }

    async function moveItem(sessionID: string) {
      const items = board()?.items ?? []
      const id = await pickItem("Which task?", "Type to search")
      if (!id || items.length < 2) return
      const index = items.findIndex((item) => item.id === id)
      const targets: { key: string; label: string; to: number }[] = []
      if (index > 0) targets.push({ key: "up", label: "↑ up one", to: index - 1 })
      if (index < items.length - 1) targets.push({ key: "down", label: "↓ down one", to: index + 1 })
      if (index > 0) targets.push({ key: "top", label: "⇈ to the top", to: 0 })
      if (index < items.length - 1) targets.push({ key: "bottom", label: "⇊ to the bottom", to: items.length - 1 })
      const choice = await ui.dialog.select<string>({
        title: `Move ${id}`,
        placeholder: "Where should it go?",
        options: targets.map((target) => ({ title: target.label, value: target.key })),
      })
      const target = targets.find((entry) => entry.key === choice)
      if (target) await mutate(sessionID, { op: "move", id, to: target.to })
    }

    async function clearBoard(sessionID: string) {
      const count = board()?.items.length ?? 0
      if (count === 0) {
        await ui.dialog.alert({ title: "Clear the board", message: EMPTY_BOARD })
        return
      }
      const ok = await ui.dialog.confirm({
        title: "Clear the board",
        message: `Delete all ${count} task${count === 1 ? "" : "s"}?`,
      })
      if (ok) await mutate(sessionID, { op: "clear" }, `Cleared ${count} task${count === 1 ? "" : "s"}`)
    }

    async function controlPanel(sessionID: string) {
      const nudge = board()?.nudge
      const choice = await ui.dialog.select<string>({
        title: "Kanban — nudge control",
        placeholder: "What do you want to change?",
        options: [
          { title: "Continue nudging (reset the counter)", value: "resume" },
          { title: "Un-pause nudging (keep the counter)", value: "unpause" },
          { title: "Pause nudging", value: "pause" },
          { title: "Mark every open item done", value: "done" },
          { title: "Clear the board", value: "clear" },
        ],
      })
      if (choice === "resume") await mutate(sessionID, { op: "resume" })
      else if (choice === "unpause") await mutate(sessionID, { op: "unpause" })
      else if (choice === "pause") await mutate(sessionID, { op: "pause" })
      else if (choice === "done") {
        const open = (board()?.items ?? []).filter((item) => item.status !== "done")
        for (const item of open) await mutate(sessionID, { op: "update", id: item.id, status: "done" })
      } else if (choice === "clear") await clearBoard(sessionID)
      else void nudge
    }

    // --- commands ------------------------------------------------------------

    const handlers: Record<string, (sessionID: string) => void | Promise<void>> = {
      "kanban.open": (sessionID) => {
        ui.panel.open(PANEL)
        void refresh(sessionID)
      },
      "kanban.add": async (sessionID) => {
        const title = await ui.dialog.prompt({ title: "Add a kanban task", placeholder: "What needs doing?" })
        if (title?.trim()) await mutate(sessionID, { op: "add", title: title.trim() })
      },
      "kanban.done": async (sessionID) => {
        const id = await pickItem("Mark done", "Type to search, Enter marks it done")
        if (id) await mutate(sessionID, { op: "update", id, status: "done" })
      },
      "kanban.remove": async (sessionID) => {
        const id = await pickItem("Remove a task", "Type to search, Enter removes it")
        if (id) await mutate(sessionID, { op: "remove", id })
      },
      "kanban.move": (sessionID) => moveItem(sessionID),
      "kanban.current": async (sessionID) => {
        const id = await pickItem("Set the current task", "A nudge points at this one")
        if (id) await mutate(sessionID, { op: "current", id }, `Current: ${id}`)
      },
      "kanban.edit": async (sessionID) => {
        const id = await pickItem("Edit which task?", "Type to search")
        if (!id) return
        const item = board()?.items.find((entry) => entry.id === id)
        if (!item) return
        const title = await ui.dialog.prompt({ title: `Edit ${item.id}`, value: item.title })
        if (title?.trim() && title.trim() !== item.title) {
          await mutate(sessionID, { op: "update", id, title: title.trim() })
        }
      },
      "kanban.clear": (sessionID) => clearBoard(sessionID),
      "kanban.control": (sessionID) => controlPanel(sessionID),
      "kanban.continue": (sessionID) => mutate(sessionID, { op: "resume" }, "Nudging resumed"),
      "kanban.stop": (sessionID) => mutate(sessionID, { op: "pause" }, "Nudging paused"),
    }

    ctx.keymap.layer(() => ({
      commands: COMMANDS.map((spec) => ({
        id: spec.name,
        title: spec.title,
        description: spec.hint,
        group: spec.category,
        palette: true as const,
        slash: { name: spec.slashName },
        run: () => void handlers[spec.name]?.(sessionIDOf(ui.panel.current()?.sessionID ?? currentSession())),
      })),
    }))

    function currentSession(): string {
      const route = ui.router.current()
      const params = (route as { params?: Record<string, unknown> }).params
      return typeof params?.sessionID === "string" ? params.sessionID : ""
    }

    return () => {
      watcher?.close()
      if (debounce) clearTimeout(debounce)
    }
  },
})