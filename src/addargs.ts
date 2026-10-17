/**
 * `/add` argument parsing.
 *
 * `/add "do a thing"`                → a root task
 * `/add k3 "do a thing"`            → a subtask filed under k3
 * `/add k3 "do it" extra words`     → keeps the quotes as the title boundary
 *
 * The quotes are what make this usable from a prompt: a task title is almost
 * never a single word, so without them every title would need escaping and
 * `/add` could not distinguish a parent id from the first word of the title.
 */

export type ParsedAdd = { parentID?: string; title: string }

/** `/add` accepts an optional parent id, then a quoted title. */
export function parseAdd(input: string | undefined): ParsedAdd | null {
  const text = (input ?? "").trim()
  if (!text) return null

  const quoted = /"([^"]*)"|'([^']*)'/.exec(text)
  if (!quoted) {
    // Unquoted: an id followed by words, or just words.
    const parts = text.split(/\s+/)
    if (parts.length === 1) return { title: parts[0]! }
    if (isParentRef(parts[0]!)) return { parentID: parts.shift(), title: parts.join(" ") }
    return { title: text }
  }

  const title = (quoted[1] ?? quoted[2] ?? "").trim()
  if (!title) return null

  const before = text.slice(0, quoted.index).trim()
  if (!before) return { title }
  const first = before.split(/\s+/)[0]!
  // Only treat it as a parent if it actually looks like one — otherwise the
  // leading words are part of the instruction.
  return isParentRef(first) ? { parentID: first, title } : { title }
}

/** `k7`, `k12` — a task id, not an arbitrary first word. */
function isParentRef(token: string): boolean {
  return /^k\d+$/i.test(token)
}
/** Generic shape for the argument-taking commands: ids, then a quoted title. */
export type ParsedArgs = { ids: string[]; title?: string }

/**
 * Parse `/cmd k1 k2 "title"` for any command that accepts arguments.
 *
 * Anything matching `k<digits>` before the quoted part is an id; the quoted
 * part is a title. Everything else is treated as a title, so a command never
 * silently swallows what the user typed.
 */
export function parseArgs(input: string | undefined): ParsedArgs {
  const text = (input ?? "").trim()
  if (!text) return { ids: [] }

  const quoted = /"([^"]*)"|'([^']*)'/.exec(text)
  const title = quoted ? (quoted[1] ?? quoted[2] ?? "").trim() || undefined : undefined
  const before = (quoted ? text.slice(0, quoted.index) : text).trim()
  const words = before ? before.split(/\s+/) : []

  if (quoted) return { ids: words.filter(isParentRef), title }

  const ids = words.filter(isParentRef)
  const rest = words.filter((word) => !isParentRef(word))
  return { ids, title: rest.length > 0 ? rest.join(" ") : undefined }
}

/**
 * Split slash-command input into words, honouring quotes.
 *
 * A plain `split(/\s+/)` turns `/ock import ~/my tasks/tasks.md` into two words
 * and silently imports the wrong one — or none, since the first half is not a
 * file. Paths have spaces in them constantly, so the rule has to be quotes, and
 * `parseArgs` gets it for free because it is now expressed in terms of this.
 */
export function splitArgs(input: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) words.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}
