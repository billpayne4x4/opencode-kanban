/**
 * The board as a markdown checklist, and back again.
 *
 * This exists because of a real failure mode. The board lives in a JSON file
 * inside `.opencode/`, which is a plugin's private scratch space: invisible in
 * a diff, absent from a backup, and destroyed by anything that cleans unknown
 * directories. Someone who spent an hour with an agent decomposing a project
 * into forty tasks owns that work in exactly one place, and it is a place a
 * human cannot easily see.
 *
 * So the board gets a form a person can read, commit, and hand to a colleague.
 * `.ai/tasks.md`, indented checkboxes — the shape every checklist already has.
 *
 * Round-tripping is the constraint that decides everything else. A backup you
 * cannot restore is a screenshot, so the parser and the renderer are written as
 * inverses and tested as a pair: export, wipe, import, and the board must come
 * back with its tree intact. Depth is carried by indentation for the same
 * reason — it is what a human editing the file would reach for.
 *
 * Pure, so both directions are testable without a filesystem.
 */

import { type Board, type ItemStatus } from "./types.ts"
import { treeRows } from "./board.ts"

/** Where the export lands, relative to the project root. */
export const TASKS_DIR = ".ai"
export const TASKS_FILE = "tasks.md"
export const TEMPLATE_FILE = "tasks.template.md"

/** One level of a parsed checklist. */
export type ParsedNode = {
  title: string
  detail?: string
  status: ItemStatus
  children: ParsedNode[]
}

/**
 * Status glyphs.
 *
 * `[ ]` and `[x]` are the two everyone recognises, and they carry the only two
 * states that matter on a backup file. The other two get glyphs rather than
 * collapsing into `[ ]`, because losing "blocked" on a round trip turns a real
 * signal into a silent one — the file would claim everything was merely pending.
 */
const STATUS_GLYPHS: Record<ItemStatus, string> = {
  pending: "[ ]",
  in_progress: "[-]",
  blocked: "[!]",
  done: "[x]",
}

const GLYPH_STATUS: Record<string, ItemStatus> = {
  "[ ]": "pending",
  "[-]": "in_progress",
  "[/]": "in_progress",
  "[>]": "in_progress",
  "[!]": "blocked",
  "[x]": "done",
  "[X]": "done",
}

/** Spaces per level. Two is what a human types without thinking. */
const INDENT = "  "

/** Lines longer than this are a formatting accident, not a task. */
const MAX_LINE = 1000

/**
 * The board as markdown.
 *
 * Depth-first with one indent per level, so the file is a real outline. Status
 * rides the checkbox, and `detail` follows on its own indented line — a
 * continuation, which is how markdown nests text under a list item, so the
 * detail belongs to the task above it rather than looking like a new one.
 */
export function renderTasks(board: Board, now = new Date()): string {
  const lines: string[] = [
    `# Tasks`,
    "",
    `<!-- OpenCode Kanban · ${now.toISOString()} · ${board.items.length} task(s) -->`,
    "",
    "Delete or edit anything below — `/ock import` reads this file back.",
    "",
  ]
  for (const { item, depth } of treeRows(board)) {
    const pad = INDENT.repeat(depth)
    lines.push(`${pad}- ${STATUS_GLYPHS[item.status]} ${item.title}`)
    if (item.detail) {
      // Continuation lines: indented past the marker, so markdown folds them
      // into the item above. Blank lines are kept so a multi-paragraph detail
      // survives, which is the whole reason detail is worth keeping.
      for (const part of item.detail.split("\n")) {
        lines.push(part.trim() ? `${pad}${INDENT}${INDENT}${part}` : "")
      }
    }
  }
  return lines.join("\n") + "\n"
}

/** A `- [x] title` line, with its indent width and any detail lines. */
type Line = { indent: number; glyph: string; title: string; detail: string[] }

/** Tabs are a width, not a character; one tab counts as two spaces of level. */
function indentWidth(line: string): { width: number; rest: string } {
  let width = 0
  let rest = line
  for (;;) {
    if (rest.startsWith(" ")) {
      width += 1
      rest = rest.slice(1)
      continue
    }
    if (rest.startsWith("\t")) {
      width += 2
      rest = rest.slice(1)
      continue
    }
    break
  }
  return { width, rest }
}

/** Is this line a checklist item? `*` and `+` are legal markdown and get read. */
const ITEM = /^([-*+])\s+\[(.)\]\s*(.*)$/

function readLines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split("\n")) {
    if (raw.length > MAX_LINE) throw new Error(`line ${out.length + 1} is ${raw.length} characters; keep task lines under ${MAX_LINE}`)
    const { width, rest } = indentWidth(raw)
    const match = ITEM.exec(rest)
    if (match) {
      const title = match[3]!.trim()
      // Kept raw. The continuation prefix cannot be stripped here, because
      // stripping it needs the indent of the item it belongs to, and that item
      // may turn out to be a parent rather than the previous line.
      if (title) out.push({ indent: width, glyph: `[${match[2]}]`, title, detail: [] })
      continue
    }
    if (out.length === 0) continue
    const previous = out[out.length - 1]!
    // A blank line inside an open detail is part of it, not a gap in the file.
    if (!rest.trim()) {
      if (previous.detail.length > 0) previous.detail.push("")
      continue
    }
    // Otherwise only an indented line continues the item. Flush-left prose
    // between two tasks is somebody's note, and must not become an item's detail.
    if (width > previous.indent) previous.detail.push(raw)
  }
  return out
}

/** Strip the continuation prefix and the blank lines around a detail block. */
function joinDetail(lines: string[], indent: number): string | undefined {
  if (lines.length === 0) return undefined
  const body = lines
    .map((line) => (line ? line.slice(indent + 4).trim() : ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
  return body || undefined
}

/**
 * Parse a checklist back into a tree.
 *
 * Indentation is relative, not absolute: the shallowest item on the file is a
 * root no matter how far right it starts. A file indented by four spaces
 * throughout is as valid as one indented flush left, and rejecting it would be
 * a surprise for someone who pasted from a doc.
 *
 * An unknown glyph is read as `[ ]` rather than an error. The file is meant to
 * be edited by hand, and a hand that typed `[*]` meant "a task", not "fail".
 */
export function parseTasks(text: string): ParsedNode[] {
  const lines = readLines(text)
  if (lines.length === 0) throw new Error("no tasks found — the file has no `- [ ] title` lines")
  const base = Math.min(...lines.map((line) => line.indent))

  const roots: ParsedNode[] = []
  // Ancestor stack, so each item attaches to the deepest level above it that is
  // still shallower than itself.
  const stack: { indent: number; node: ParsedNode }[] = []

  for (const line of lines) {
    const level = Math.max(0, Math.round((line.indent - base) / 2))
    const detail = joinDetail(line.detail, line.indent)
    const node: ParsedNode = {
      title: line.title,
      status: GLYPH_STATUS[line.glyph] ?? "pending",
      children: [],
      ...(detail ? { detail } : {}),
    }
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= level) stack.pop()
    const parent = stack[stack.length - 1]?.node
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push({ indent: level, node })
  }
  return roots
}

/** How many tasks a parsed tree holds, folders included. */
export function countNodes(nodes: ParsedNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0)
}

/**
 * A starting point for someone who has never used this.
 *
 * One task per level, three deep, because that is the thing nobody can guess:
 * whether nesting is allowed at all, and how far. A template that only showed a
 * flat list would teach the easy half and leave the useful half undocumented.
 */
export const TEMPLATE = `# Tasks

<!-- A template. Copy it over tasks.md and edit, or just edit this one. -->

Delete or edit anything below — \`/ock import\` reads this file back.

- [ ] Phase 1: understand the problem
  - [ ] Write down what "working" looks like
    - [ ] One concrete acceptance test
      - [ ] Run it and watch it fail first
- [ ] Phase 2: do the work
  - [ ] The smallest version that proves the idea
  - [ ] Then the rest of it
- [ ] Phase 3: prove it
  - [ ] Measure something, do not assert it
`