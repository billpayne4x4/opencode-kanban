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
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { type Board, type Item } from "./types.ts"
import { checkbox, itemLabel, panelRule, panelTitle, statusCells, EMPTY_BOARD } from "./format.ts"
import { ENTRIES, humanOptions } from "./catalog.ts"
import { childrenOf, containerDone, descendantProgress, nextItem, progress, treeRows } from "./board.ts"
import { type Mutation, type Store, apply } from "./actions.ts"
import { nudgeBudget, nudgeEnabled } from "./nudge.ts"
import { DEBUG_LOG, DEBUG_PANEL_LABEL, debug, debugOn } from "./debug.ts"
import { COMMANDS, DEFAULT_ROOT, HALT_HINT, ROOT_ALIASES, VERBS } from "./commands.ts"

/**
 * Verb typed after `/ock` → the handler it dispatches to.
 *
 * Two jobs: the short forms (`rm`, `sub`) and the places where a verb is called
 * something different internally (`remove` vs `rm`). Explicit rather than
 * derived, because a typo here silently makes a verb vanish from the prompt.
 */
const VERB_TARGET: Record<string, string> = {
  help: "help",
  export: "export",
  import: "import",
  template: "template",
  notify: "notify",
  add: "add",
  done: "done",
  finish: "done",
  edit: "edit",
  rm: "remove",
  del: "remove",
  remove: "remove",
  delete: "remove",
  current: "current",
  move: "move",
  folder: "folder",
  sub: "subtask",
  subtask: "subtask",
  // Both spellings, because the catalogue documents the hyphenated one and
  // muscle memory says the joined one. A verb that looks documented but
  // answers "unknown verb" is worse than one that was never listed.
  "add-many": "add-many",
  addmany: "add-many",
  "remove-many": "remove-many",
  removemany: "remove-many",
  "move-many": "move-many",
  movemany: "move-many",
  "update-many": "update-many",
  updatemany: "update-many",
  subtasks: "subtasks",
  reparent: "reparent",
  clear: "clear",
  control: "control",
  run: "run",
  pause: "pause",
  stop: "stop",
  continue: "continue",
  nudgeon: "nudge-on",
  nudgeoff: "nudge-off",
  // Hyphenated aliases for the same reason as the plurals above: the
  // hyphenated spelling is the readable one and the one the catalogue prints.
  "nudge-on": "nudge-on",
  "nudge-off": "nudge-off",
  budget: "budget",
  debugon: "debug-on",
  debugoff: "debug-off",
  "debug-on": "debug-on",
  "debug-off": "debug-off",
  debuglog: "debug-log",
  log: "debug-log",
}
import { parseAdd, parseArgs } from "./addargs.ts"
import { STATE_DIR, STATE_FILE, load, save } from "./store.ts"
import { projectFiles } from "./files.ts"

const PANEL = "kanban.board"

/** Which channel announces a change unless the board says otherwise. */
const DEFAULT_NOTIFY = "panel"
/** How long a block stays up. Long enough to read, short enough not to be furniture. */
const NOTICE_MS = 6000

type NoticeVariant = "info" | "success" | "warning" | "error"

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

    // Stamped on every read and write so a debug line can name its window.
    const project = worktree.split("/").filter(Boolean).pop() ?? worktree

    const io: Store = {
      read: async (sessionID) => ({ ...(await load(worktree, sessionID)), project }),
      write: (board) => save(worktree, { ...board, project }),
      // The human-facing side may read a file they name explicitly. The server's
      // handle (index.ts) deliberately does not, so the agent's tool call stays
      // confined to the project however it is argued.
      files: projectFiles(worktree, { allowAbsoluteRead: true }),
    }

    const [board, setBoard] = createSignal<Board | undefined>()
    const [loadedSession, setLoadedSession] = createSignal("")
    /** Which session the sidebar is rendering; the watcher reloads this one. */
    const [sidebarSession, setSidebarSession] = createSignal("")

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
        if (mine === seq) {
          setBoard(next)
          setLoadedSession(sessionID)
        }
      } catch {
        // A transient read failure just leaves the panel on its last good view.
      }
    }

    /**
     * Load a session's board the first time a slot asks for it.
     *
     * Called from slot render, so it schedules the load rather than doing it
     * inline: mutating a signal during render is how you get a half-updated
     * pane, and this runs on every render of every session that is on screen.
     */
    function ensureLoaded(sessionID: string) {
      if (!sessionID) return
      if (sidebarSession() !== sessionID) setSidebarSession(sessionID)
      if (loadedSession() === sessionID) return
      void refresh(sessionID)
    }

    /**
     * The most recent change, for the in-window block.
     *
     * One notice at a time, not a queue. A queue would be honest about history
     * and useless in practice: by the time a burst of five had drained, the one
     * that mattered was off the top and gone. The latest thing that happened is
     * the thing you want to know.
     */
    const [notice, setNotice] = createSignal<{ sessionID: string; variant: NoticeVariant; body: string } | undefined>()

    /**
     * Announce a change.
     *
     * `panel` draws a coloured block that stays put and is sized to the pane;
     * `toast` is the host's own notification. One call per *operation*, never
     * per item — `addMany` of six is one notice, because six notices for one
     * deliberate act is noise, and the notice that gets missed is the one you
     * needed.
     */
    function notify(sessionID: string, variant: NoticeVariant, message: string) {
      const mode = board()?.sessionID === sessionID ? board()?.notify : undefined
      if ((mode ?? DEFAULT_NOTIFY) === "panel") {
        setNotice({ sessionID, variant, body: message })
        // Cleared on a timer so a stale block cannot sit above the composer
        // forever. Long enough to read, short enough not to become furniture.
        clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => setNotice(undefined), NOTICE_MS)
        debug(undefined, "event", `notice (panel) ${variant}: ${message}`)
        return
      }
      ui.toast.show({ variant, message })
    }
    let noticeTimer: ReturnType<typeof setTimeout> | undefined

    /** Errors always use the host's toast: a block that can be missed is not an error channel. */
    function toast(variant: NoticeVariant, message: string) {
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
        notify(sessionID, "success", ok ?? message)
      } catch (error) {
        toast("error", `Kanban: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // --- the panel -----------------------------------------------------------

    /**
     * Theme tokens.
     *
     * `ctx.theme` *is* the resolved token set — there is no `.current`, and no
     * flat `accent`/`success`/`warning` keys. Getting this wrong threw inside
     * the slot render, which is how a correctly-installed panel still showed
     * nothing. The types now come from `@opencode/theme`, so a wrong token is a
     * compile error rather than a silent blank pane.
     */
    const tones = () => {
      const t = ctx.theme
      return {
        heading: t.text.base,
        rule: t.text.faint,
        surface: t.background.raised.base,
        muted: t.text.muted,
        error: t.text.feedback.error.base,
        blocked: t.text.feedback.warning.base,
        /**
         * Every row colour, and nothing else.
         *
         * All named semantic tokens — no hue steps, no measured pairs. An
         * earlier version spent a lot of code deriving "light blue" and "dark
         * blue" from the accent ramp: sorting it by measured luminance, because
         * a theme may run the ramp in either direction, and filtering it by
         * contrast, because a theme's dark end can be unreadable. All of that
         * existed only because it had to choose *steps*. The theme already
         * names these two states outright, and a named token re-tints with the
         * theme while a step number only means something in one of them.
         *
         * ```text
         * success  the task you are on
         * info     the folder holding it, and the folders back to root
         * white    everything still to do, folders included
         * muted    finished — greyed out of the way
         * warning  blocked
         * ```
         */
        active: t.text.feedback.success.base,
        holding: t.text.feedback.info.base,
        finished: t.text.faint,
      }
    }

    function Board(props: { sessionID: string; width?: number }) {
      const theme = tones()
      const items = createMemo(() =>
        board()?.sessionID === props.sessionID ? treeRows(board()!) : [],
      )
      const counts = createMemo(() => progress({ items: items().map((row) => row.item) }))
      const title = createMemo(() => panelTitle(counts().done, counts().total))
      const nudge = () => (board()?.sessionID === props.sessionID ? board()?.nudge : undefined)
      /**
       * The item the marker follows.
       *
       * `currentID` is only set once something sets it, so keying the
       * marker off it alone leaves a fresh board with no marker at all.
       * This is the same resolution the nudge uses — explicit current,
       * then in-progress, then first pending — so the marker always shows
       * you what a nudge would point at.
       */
      const focus = createMemo(() => {
        const b = board()
        return b && b.sessionID === props.sessionID ? nextItem(b)?.id : undefined
      })

      /**
       * The rule should span the pane, so it needs the pane's width.
       *
       * `session.panel` hands one down. The sidebar does not, so measure it off
       * the renderable instead. Layout has not run when the ref fires, hence the
       * sampling — which also means a terminal resize re-wraps the rule instead
       * of leaving it the wrong length.
       */
      let element: { width?: number } | undefined
      const [measured, setMeasured] = createSignal(0)
      onMount(() => {
        const timer = setInterval(() => {
          const width = typeof element?.width === "number" ? element.width : 0
          if (width > 0 && width !== measured()) setMeasured(width)
        }, 120)
        onCleanup(() => clearInterval(timer))
      })
      const span = createMemo(() => props.width ?? measured())
      const childMap = createMemo(() => {
        const map: Record<string, Item[]> = {}
        for (const item of board()?.items ?? []) {
          if (!item.parentID) continue
          ;(map[item.parentID] ??= []).push(item)
        }
        return map
      })

      const mine = createMemo(() => (board()?.sessionID === props.sessionID ? board() : undefined))
      const cells = createMemo(() => statusCells(mine()))

      const hasKids = (item: Item) => childMap()[item.id] !== undefined
      /* Counts every level beneath a container, not just its direct children.
         `(0/4)` has to mean "none of the four, at any depth" or it lies: a
         folder with two subtasks that each have two of their own is complete
         when all six are done, not when its two children are. */
      const spread = (item: Item) => descendantProgress(board()!, item.id)

      /**
 * The colour of a row's text.
 *
 * Order encodes a priority: what you are doing now beats what kind of thing it
 * is. A folder cannot reach the focus branch — `nextItem` descends past
 * containers — so "active" and "folder" never compete for one row, and the
 * status colours are only ever reached by real tasks, which is what keeps them
 * meaning something.
 */
      const tone = (item: Item) => {
        // Exactly one thing on this panel is coloured for being current. An
        // earlier version also tinted the folder holding it, and then the
        // folders above that — three coloured rows for one fact, which made a
        // nested board look busy rather than informative. The path to root is
        // already answered by indentation and the counts.
        if (item.id === focus()) return theme.active
        // Blocked is the one status that needs shouting about even when it is
        // not the task you are on, so it keeps its own colour.
        if (item.status === "blocked") return theme.blocked
        // Finished greys out, so work that is done stops competing for the eye.
        if (item.status === "done") return theme.muted
        // Everything else is white: the folders on your path, the folders off
        // it, in-progress items, and the pending tasks. `in_progress` is here
        // rather than in a colour of its own because the green already follows
        // it — `nextItem` prefers an in-progress item, so it *is* the focus.
        return theme.finished
      }

      return (
        <box flexDirection="column" ref={(el: { width?: number }) => (element = el)}>
          <text fg={theme.heading}>
            <b>{title()}</b>
          </text>
          <text fg={theme.rule}>{panelRule(span())}</text>

          <Show when={items().length > 0}>
            <box flexDirection="column">
              <For each={items()}>
                {({ item, depth }) => (
                  /* One step per level, not one for "has a parent": a binary
                     indent renders a four-level tree as two flat tiers, which
                     looks exactly like no nesting at all. */
                  <box flexDirection="row" gap={1} paddingLeft={depth * 2}>
                    {/* One marker column, not two.
                        The focus marker and the folder marker were both `▸`,
                        so the current item drew as `▸ ▸` whenever it happened to
                        be a folder — two identical glyphs meaning "you are
                        here" and "this has children", which is worse than one
                        glyph meaning neither. Whichever is true of the row wins
                        the column, so there is never a doubled glyph. */}
                    <text flexShrink={0} fg={tone(item)}>
                      {/* A container gets a checkbox too, and it reads `[x]` only
                          when every level beneath it is done. `▸` stays reserved
                          for the task you are on: two glyphs for two meanings,
                          which is the mistake this column used to make. */}
                      {item.id === focus() ? "▸" : checkbox(hasKids(item) ? (containerDone(board()!, item.id) ? "done" : "pending") : item.status)}
                    </text>
                    {/* Wrapped, not truncated. A title cut to `w-10`
                        characters is unreadable, and these are instructions the
                        agent has to follow literally. */}
                    {/* `tone()` for every row, folders included. Folders used to
                        take a fixed colour so they would stand out from leaves —
                        which quietly demoted the active task to that same colour
                        whenever it happened to be a folder, i.e. most of the time
                        on a nested board. The `▾` and the `(2/3)` already say
                        "this is a container"; the text colour is the one channel
                        left for "you are here". */}
                    <text flexGrow={1} wrapMode="word" fg={tone(item)}>
                      {hasKids(item) ? `${item.title} (${spread(item).done}/${spread(item).total})` : item.title}
                    </text>
                  </box>
                )}
              </For>
            </box>

            {/* A second rule, so the list and the status row read as two
                separate blocks instead of the status looking like the last
                item. Only with items present — on an empty board it would sit
                directly under the heading rule and read as a double line. */}
            <text fg={theme.rule}>{panelRule(span())}</text>
          </Show>

          {/* Under the list, laid out as one justified row: status hard left,
              the nudge summary hard right, and dots spread evenly between so
              the line reads as one rule rather than two floating labels. */}
          {/* Labels separated by dots, in one `space-between` row.
              `width="100%"` is what makes that work: without a definite width
              Yoga sizes the row to its content and there is no free space to
              distribute, which is why the dots once came out glued to the
              words. The host does the spacing, so a resize stays correct
              without recomputing anything. */}
          <box flexDirection="row" justifyContent="space-between" width="100%">
            <For each={cells()}>
              {(cell) =>
                cell.kind === "dot" ? (
                  <text fg={theme.rule}>{"·"}</text>
                ) : (
                  <text fg={cell.tone === "alert" ? theme.error : theme.muted}>{cell.value}</text>
                )
              }
            </For>
          </box>

          {/* Debug marker. Rendered only while logging is on, so the panel looks
              exactly as it normally does when it is off. */}
          <Show when={debugOn(mine())}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.active}>
                {"●"}
              </text>
              <text fg={theme.muted}>{DEBUG_PANEL_LABEL}</text>
            </box>
          </Show>
        </box>
      )
    }

    // Always visible in the right-hand sidebar. This is the surface the user
    // actually looks at, so the board cannot be hidden behind a command.
    /**
     * The in-window notice.
     *
     * `session.composer.top` is the one slot that sits in the main window above
     * the composer, which is where a change you made a second ago belongs: a
     * toast fires off into a corner and is gone, while this stays put, is
     * sized to the pane, and is still there when you look back down.
     *
     * A left border in the variant's colour rather than a fully tinted block:
     * a saturated fill behind text is the single most reliable way to make text
     * unreadable, and this sits directly above a prompt someone is about to
     * type into. The bar carries the colour; the text stays legible.
     */
    /**
     * Exactly one command owns the slash name.
     *
     * Every command used to declare `slash: { name: "ock" }`, so the host was
     * handed twenty-eight competing entries for one name. Typing `/ock clear`
     * still worked — one of the twenty-eight won — but the autocomplete said
     * "no matching commands", which is the only place anyone discovers the
     * command exists.
     *
     * And the test that should have caught it counted the *string* `slash: {
     * name:` in the source: one line, so one command, green. It said nothing
     * about what the map produces at runtime, which was twenty-eight. A source
     * assertion about a runtime count is a test of the wrong thing.
     *
     * So `kanban.open` owns `/ock` and dispatches on the verb; the rest stay in
     * the palette, which is where a named command belongs.
     */
    ctx.keymap.layer(() => ({
      commands: COMMANDS.map((spec) => ({
        id: spec.name,
        title: spec.title,
        description: spec.hint,
        group: spec.category,
        palette: true as const,
        // One owner, not twenty-eight claimants of the same name.
        ...(spec.name === "kanban.open"
          ? { slash: { name: DEFAULT_ROOT, aliases: ROOT_ALIASES, arguments: true as const } }
          : {}),
        run: (input) => {
          void (async () => {
            const id = sessionIDOf(ui.panel.current()?.sessionID ?? currentSession())
            debug(
              await io.read(id).catch(() => undefined),
              "command",
              `/${DEFAULT_ROOT}${input ? ` ${input}` : ""} -> ${spec.name}`,
            )
            await handlers[spec.name]?.(id, input)
          })()
        },
      })),
    }))

    /**
     * Claim a slot, and survive failing to.
     *
     * Setup is one long function, so anything that throws part-way through takes
     * everything after it down with it. That is not hypothetical: the notice
     * block claimed `session.composer.top`, which is the one slot whose contract
     * this plugin had never exercised, and if it throws then the sidebar never
     * registers, the panel never appears, and `/ock` vanishes from the slash
     * list — because the keymap layer was registered *after* it. A view taking
     * the commands down with it is the wrong way round.
     *
     * So each claim stands alone. A slot the host does not publish is a missing
     * panel, not a missing command.
     */
    function claim(slot: Parameters<typeof ui.slot>[0]) {
      try {
        return ui.slot(slot)
      } catch (error) {
        console.error(`[kanban] slot ${String((slot as { append?: string; prepend?: string }).append ?? (slot as { prepend?: string }).prepend)} not claimed: ${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }

    claim({
      prepend: "session.composer.top",
      render: (input) => {
        const theme = tones()
        let element: { width?: number } | undefined
        const [measured, setMeasured] = createSignal(0)
        onMount(() => {
          // The slot publishes only a session id, so the width has to be read
          // off the renderable — and layout has not run when the ref fires,
          // hence sampling. Which also means a resize re-renders the rule
          // rather than leaving it the wrong length.
          const timer = setInterval(() => {
            const width = typeof element?.width === "number" ? element.width : 0
            if (width > 0 && width !== measured()) setMeasured(width)
          }, 120)
          onCleanup(() => clearInterval(timer))
        })

        const tone = (variant: NoticeVariant) =>
          variant === "error"
            ? theme.error
            : variant === "warning"
              ? theme.blocked
              : variant === "success"
                ? theme.active
                : theme.holding

        return (
          <Show when={notice()?.sessionID === input.sessionID ? notice() : undefined}>
            {(current) => (
              <box
                ref={(el: { width?: number }) => (element = el)}
                flexDirection="row"
                border={["left"]}
                borderColor={tone(current().variant)}
                backgroundColor={theme.surface}
                paddingLeft={2}
                paddingRight={2}
                width="100%"
              >
                <text flexShrink={0} fg={tone(current().variant)}>
                  {"▌"}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme.heading}>
                  {current().body}
                </text>
              </box>
            )}
          </Show>
        )
      },
    })

    claim({
      append: "sidebar.content",
      render: (input) => {
        ensureLoaded(input.sessionID)
        return <Board sessionID={input.sessionID} />
      },
    })

    // The expanded view. `session.panel` renders only while a panel is open, so
    // `/kanban` opens it; the host owns layout, scrolling and full-screen.
    claim({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL) return <box />
        ensureLoaded(input.sessionID)
        return <Board sessionID={input.sessionID} width={input.width} />
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
        const target = sidebarSession() || ui.panel.current()?.sessionID || ""
          debounce = setTimeout(() => void refresh(target), WATCH_DEBOUNCE_MS)
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

    /** Choose a folder, or the top level when `allowTop`. */
    async function pickFolder(allowTop = false): Promise<string | undefined> {
      const folders = (board()?.items ?? []).filter((item) => childrenOf(board()!, item.id).length > 0)
      const options = folders.map((folder) => ({ title: `${folder.id} · ${folder.title}`, value: folder.id }))
      if (allowTop) options.unshift({ title: "— top level —", value: "" })
      if (options.length === 0) {
        await ui.dialog.alert({ title: "No folders yet", message: `Create one with /${DEFAULT_ROOT} folder first.` })
        return undefined
      }
      const choice = await ui.dialog.select<string>({ title: "Folder", placeholder: "Which one?", options })
      return choice ?? undefined
    }

    /** Ask for a new budget. Free-text, validated, with a sensible range. */
    async function setBudget(sessionID: string) {
      const answer = await ui.dialog.prompt({
        title: "How many nudges before it halts?",
        placeholder: "3",
        description: "How many times the plugin may restart a stalled agent before it gives up.",
        value: String(board()?.nudge?.maxAttempts ?? 3),
      })
      if (answer === undefined) return
      const value = Number.parseInt(answer.trim(), 10)
      // No tight upper bound: the value is also a layout element, and a
      // four-digit budget has to render sensibly rather than be rejected.
      if (!Number.isFinite(value) || value < 1 || value > 9999) {
        toast("error", "Kanban: give a whole number between 1 and 9999")
        return
      }
      await mutate(sessionID, { op: "count", maxAttempts: value })
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

    /**
     * The one place every control lives.
     *
     * Each option shows the state it would change, so the menu is also a
     * readout — you can see what run/stopped, on/off and the try budget are
     * without hunting through slash commands.
     */
    async function controlPanel(sessionID: string) {
      const state = board()
      const budget = nudgeBudget(state?.nudge)
      const enabled = nudgeEnabled(state?.nudge)
      const choice = await ui.dialog.select<string>({
        title: `Kanban — /${DEFAULT_ROOT}`,
        placeholder: "Currently: " + statusCells(state).filter((c) => c.kind === "text").map((c) => (c as { value: string }).value).join(" · "),
        options: [
          {
            title: "Run",
            value: "resume",
            description: state?.nudge?.paused ? "Stopped — resume the board" : "Not stopped — reset the counter anyway",
          },
          {
            title: "Stop",
            value: "pause",
            description: state?.nudge?.paused ? "Already stopped" : "Halt the board until you run it again",
          },
          {
            title: enabled ? "Nudge: off" : "Nudge: on",
            value: "nudge-toggle",
            description: enabled ? "Keep the board, never be restarted by it" : "Allow the plugin to restart a stalled agent",
          },
          {
            title: `Tries: ${budget}`,
            value: "count",
            description: "Change how many nudges before it halts",
          },
          { title: "Mark every open item done", value: "done", description: "Close the board without deleting it" },
          { title: "Clear the board", value: "clear", description: "Delete every item" },
          ...Object.entries(VERBS)
            .filter(([verb]) => !["resume", "pause", "clear", "nudge", "budget", "debug", "count", "log", "debuglog", "nudgeon", "nudgeoff"].includes(verb))
            .map(([verb, help]) => ({ title: `/${DEFAULT_ROOT} ${verb}`, value: `help:${verb}`, description: help })),
        ],
      })

      if (choice === "resume") await mutate(sessionID, { op: "resume" }, "Running")
      else if (choice === "pause") await mutate(sessionID, { op: "pause" }, "Stopped")
      else if (choice === "nudge-toggle") {
        await mutate(sessionID, { op: "nudge", enabled: !enabled }, enabled ? "Nudging off" : "Nudging on")
      } else if (choice === "count") await setBudget(sessionID)
      else if (choice === "done") {
        const open = (board()?.items ?? []).filter((item) => item.status !== "done")
        for (const item of open) await mutate(sessionID, { op: "update", id: item.id, status: "done" })
      } else if (choice === "clear") await clearBoard(sessionID)
    }

    // --- commands ------------------------------------------------------------

    const handlers: Record<string, (sessionID: string, input?: string) => void | Promise<void>> = {
      "kanban.open": (sessionID, input) => {
        // `/ock done k5` -> verb "done", args "k5". One registered command
        // dispatches to every verb, so the plugin claims a single name.
        const trimmed = (input ?? "").trim()
        if (trimmed) {
          const [verb, ...rest] = trimmed.split(/\s+/)
          const key = verb!.toLowerCase()
          const verbTarget = VERB_TARGET[key]
          const target = verbTarget ? handlers[`kanban.${verbTarget}`] : undefined
          if (target) return target(sessionID, rest.join(" "))
          return toast("error", `Kanban: unknown verb "${verb}". Type /${DEFAULT_ROOT} on its own for the list.`)
        }
        ui.panel.open(PANEL)
        void refresh(sessionID)
      },
      /**
       * Backup, restore, and the starter template.
       *
       * `export` takes no arguments by design: there is one file, at a path
       * everyone can find, and a prompt for a path is a prompt to get it wrong.
       */
      "kanban.export": async (sessionID) => {
        await mutate(sessionID, { op: "export" })
      },
      "kanban.template": async (sessionID) => {
        await mutate(sessionID, { op: "template" })
      },
      /**
       * `/ock import` reads the default file; `/ock import path/to.md` reads
       * another one; `/ock import replace` swaps the board out entirely.
       *
       * Replace is a separate word rather than a flag because it is the only
       * call that can lose work on the board, and it should never be one
       * keystroke away from the safe one.
       */
      "kanban.import": async (sessionID, input) => {
        // The whole remainder is the path, not the first word of it.
        //
        // Splitting on whitespace made `/ock import ~/my tasks/tasks.md`
        // import `~/my`, silently. Paths contain spaces constantly and nobody
        // should have to quote one into a slash command, so an optional leading
        // `replace` is stripped and whatever remains is the path. Quotes are
        // still honoured if you use them.
        let rest = (input ?? "").trim()
        const replace = /^replace\b/i.test(rest)
        if (replace) rest = rest.replace(/^replace\b/i, "").trim()
        const path = rest.replace(/^["']/, "").replace(/["']$/, "").trim() || undefined
        if (!path && replace) {
          const ok = await ui.dialog.confirm({
            title: "Replace the board",
            message: `${board()?.items.length ?? 0} task(s) will be replaced by the file. This cannot be undone.`,
          })
          if (!ok) return
        }
        // `fromHuman` is what lets a person name a path outside the project. The agent's
        // own tool call never sets it, so it stays confined however it is argued.
        await mutate(sessionID, { op: "import", ...(path ? { path } : {}), merge: !replace, fromHuman: true })
      },
      /**
       * `/ock notify panel` or `/ock notify toast`; bare `/ock notify` asks.
       *
       * Both modes announce every change, and a bulk operation always
       * announces once no matter how many items it touched.
       */
      "kanban.notify": async (sessionID, input) => {
        const asked = (input ?? "").trim().toLowerCase()
        const mode = asked === "panel" || asked === "toast" ? asked : undefined
        if (!mode) {
          const choice = await ui.dialog.select<string>({
            title: "Where should changes be announced?",
            placeholder: "Currently: " + (board()?.notify === "toast" ? "toast" : "a block in the window"),
            options: [
              { title: "A coloured block in the window", value: "panel", description: "Stays put, sized to the pane" },
              { title: "A toast", value: "toast", description: "The host's own notification" },
            ],
          })
          if (!choice) return
          await mutate(sessionID, { op: "notify", mode: choice as "toast" | "panel" })
          return
        }
        await mutate(sessionID, { op: "notify", mode })
      },
      /**
       * A list, not a wall of text.
       *
       * A dialog has a fixed height. Handing it the whole catalogue pushed the
       * buttons that close it off the bottom edge, so the one command you reach
       * for when something is wrong was the one you could not get rid of.
       */
      "kanban.help": async (sessionID) => {
        const chosen = await ui.dialog.select<string>({
          title: `Kanban — /${DEFAULT_ROOT} help`,
          placeholder: "Every operation. Pick one to see when to use it",
          options: humanOptions(),
        })
        void refresh(sessionID)
        if (!chosen) return
        const entry = ENTRIES.find((candidate) => candidate.op === chosen)
        if (!entry) return
        await ui.dialog.alert({
          title: `/${DEFAULT_ROOT} ${entry.verb ?? entry.op}`,
          message: [
            entry.purpose,
            ...(entry.args.length
              ? ["", ...entry.args.map((arg) => `  ${arg.required ? "" : "?"}${arg.name} (${arg.type}) — ${arg.meaning}`)]
              : []),
            ...(entry.example ? ["", entry.example] : []),
            ...(entry.notes ?? []).map((note) => `  - ${note}`),
          ].join("\n"),
        })
      },
      // /add "do a thing"   /add k3 "do a thing"   /add   (dialog)
      "kanban.add": async (sessionID, input) => {
        if (input !== undefined) {
          const parsed = parseAdd(input)
          if (!parsed) return toast("error", "Kanban: give a title, e.g. /add \"do a thing\"")
          await mutate(
            sessionID,
            parsed.parentID ? { op: "subtask", parentID: parsed.parentID, title: parsed.title } : { op: "add", title: parsed.title },
          )
          return
        }
        const title = await ui.dialog.prompt({ title: "Add a kanban task", placeholder: "What needs doing?" })
        if (title?.trim()) await mutate(sessionID, { op: "add", title: title.trim() })
      },
      "kanban.add-many": async (sessionID) => {
        const text = await ui.dialog.prompt({
          title: "Add many tasks",
          placeholder: "one task per line",
          description: "One title per line. Lines starting with # are ignored. All are validated before anything is written.",
        })
        if (!text) return
        const items = text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"))
          .map((title) => ({ title }))
        if (items.length === 0) {
          toast("error", "Kanban: nothing to add")
          return
        }
        await mutate(sessionID, { op: "addMany", items }, `Added ${items.length} task(s)`)
      },
      // /done k5   (or /done for the picker)
      "kanban.done": async (sessionID, input) => {
        const inline = parseArgs(input).ids[0]
        const id = inline ?? (await pickItem("Mark done", "Type to search, Enter marks it done"))
        if (id) await mutate(sessionID, { op: "update", id, status: "done" })
      },
      // /rm k5   (or /rm for the picker)
      "kanban.remove": async (sessionID, input) => {
        const ids = parseArgs(input).ids
        if (ids.length > 0) {
          await mutate(sessionID, ids.length === 1 ? { op: "remove", id: ids[0]! } : { op: "removeMany", ids }, undefined)
          return
        }
        const id = await pickItem("Remove a task", "Type to search, Enter removes it")
        if (id) await mutate(sessionID, { op: "remove", id })
      },
      "kanban.move-many": async (sessionID) => {
        const text = await ui.dialog.prompt({
          title: "Move many tasks",
          placeholder: "k50 k51 k52 to 0",
          description: "Ids then a destination: 0 is the very top, -1 is the end. The ids keep the order you give them.",
        })
        if (!text) return
        const parts = text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
        const to = Number.parseInt(parts[parts.length - 1] ?? "", 10)
        const ids = parts.slice(0, -1)
        if (ids.length === 0 || !Number.isFinite(to)) {
          toast("error", "Kanban: give ids then a number, e.g. k50 k51 k52 to 0")
          return
        }
        await mutate(sessionID, { op: "moveMany", ids, to })
      },
      "kanban.update-many": async (sessionID) => {
        const text = await ui.dialog.prompt({
          title: "Update many tasks",
          placeholder: "k50 k51 done",
          description: "Ids then one of: pending, in_progress, done, blocked.",
        })
        if (!text) return
        const parts = text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
        const wanted = parts[parts.length - 1] as "pending" | "in_progress" | "done" | "blocked"
        const ids = parts.slice(0, -1)
        const valid = ["pending", "in_progress", "done", "blocked"]
        if (ids.length === 0 || !valid.includes(wanted)) {
          toast("error", "Kanban: give ids then a status, e.g. k50 k51 done")
          return
        }
        await mutate(sessionID, { op: "updateMany", ids, status: wanted })
      },
      "kanban.remove-many": async (sessionID) => {
        const text = await ui.dialog.prompt({
          title: "Remove many tasks",
          placeholder: "k30, k31, k32",
          description: "Comma or space separated ids. Nothing is removed unless every id exists.",
        })
        if (!text) return
        const ids = text.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)
        if (ids.length === 0) return
        await mutate(sessionID, { op: "removeMany", ids }, `Removed ${ids.length} task(s)`)
      },
      "kanban.folder": async (sessionID) => {
        const title = await ui.dialog.prompt({ title: "New folder", placeholder: "e.g. Port the compiler" })
        if (title?.trim()) await mutate(sessionID, { op: "folder", title: title.trim() })
      },
      "kanban.subtask": async (sessionID) => {
        const parent = await pickFolder()
        if (!parent) return
        const title = await ui.dialog.prompt({ title: `New subtask under ${parent}`, placeholder: "What needs doing?" })
        if (title?.trim()) await mutate(sessionID, { op: "subtask", parentID: parent, title: title.trim() })
      },
      "kanban.subtasks": async (sessionID) => {
        const parent = await pickFolder()
        if (!parent) return
        const text = await ui.dialog.prompt({
          title: `New subtasks under ${parent}`,
          placeholder: "one per line",
          description: "One per line; # comments ignored. Added in a single call.",
        })
        if (!text) return
        const items = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((title) => ({ title }))
        if (items.length === 0) return toast("error", "Kanban: nothing to add")
        await mutate(sessionID, { op: "subtasks", parentID: parent, items }, `Added ${items.length} subtask(s)`)
      },
      "kanban.reparent": async (sessionID) => {
        const id = await pickItem("Which task?", "Type to search")
        if (!id) return
        const parent = await pickFolder(true)
        if (parent === undefined) return
        await mutate(sessionID, { op: "reparent", id, parentID: parent })
      },
      "kanban.move": (sessionID) => moveItem(sessionID),
      // /current k5   (or /current for the picker)
      "kanban.current": async (sessionID, input) => {
        const id = parseArgs(input).ids[0] ?? (await pickItem("Set the current task", "A nudge points at this one"))
        if (id) await mutate(sessionID, { op: "current", id }, `Current: ${id}`)
      },
      // /edit k5 "new text"   (or /edit for the picker)
      "kanban.edit": async (sessionID, input) => {
        const parsedArgs = parseArgs(input)
        const id = parsedArgs.ids[0] ?? (await pickItem("Edit which task?", "Type to search"))
        if (!id) return
        const item = board()?.items.find((entry) => entry.id === id)
        if (!item) return
        const title = parsedArgs.title ?? (await ui.dialog.prompt({ title: `Edit ${item.id}`, value: item.title }))
        if (title?.trim() && title.trim() !== item.title) {
          await mutate(sessionID, { op: "update", id, title: title.trim() })
        }
      },
      "kanban.clear": (sessionID) => clearBoard(sessionID),
      "kanban.run": (sessionID) => mutate(sessionID, { op: "resume" }, "Running"),
      "kanban.pause": (sessionID) => mutate(sessionID, { op: "pause" }, "Paused"),
      "kanban.nudge-on": (sessionID) => mutate(sessionID, { op: "nudge", enabled: true }, "Nudging on"),
      "kanban.nudge-off": (sessionID) => mutate(sessionID, { op: "nudge", enabled: false }, "Nudging off"),
      "kanban.budget": (sessionID) => setBudget(sessionID),
      "kanban.debug-on": (sessionID) => mutate(sessionID, { op: "debug", enabled: true }, `Debug log: ${DEBUG_LOG}`),
      "kanban.debug-off": (sessionID) => mutate(sessionID, { op: "debug", enabled: false }, "Debug log off"),
      // `/ock log` asked where the log is. The verb was documented and
      // dispatched, and the handler it dispatched to did not exist — so it
      // answered "unknown verb" on the one question a person debugging this
      // plugin is most likely to ask.
      "kanban.debug-log": (sessionID) => {
        const state = board()?.sessionID === sessionID ? board() : undefined
        const where = state?.debug ? `logging to ${DEBUG_LOG}` : `not logging. ${DEBUG_LOG} is where it goes`
        toast("info", `Kanban: ${where}`)
      },
      "kanban.control": (sessionID) => controlPanel(sessionID),
      "kanban.continue": (sessionID) => mutate(sessionID, { op: "resume" }, "Nudging resumed"),
      "kanban.stop": (sessionID) => mutate(sessionID, { op: "pause" }, "Nudging paused"),
    }

    function currentSession(): string {
      const route = ui.router.current() as { params?: Record<string, unknown> }
      const id = route?.params?.sessionID
      if (typeof id === "string") return id
      return loadedSession()
    }

    return () => {
      watcher?.close()
      if (debounce) clearTimeout(debounce)
    }
  },
})