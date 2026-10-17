/**
 * Project-root file access for export and import.
 *
 * Separate from the board store because the board is one file the plugin owns,
 * and giving every mutation a filesystem would make "what can this change?" a
 * much harder question to answer. Only `export`, `import` and `template` ever
 * reach for this.
 *
 * `projectFiles` throws on a path that escapes the root. The agent picks these
 * paths, and an agent can be talked into `../../.ssh/authorized_keys` by
 * anything it reads — so the refusal lives here, at the only place a path
 * becomes a real filesystem operation, rather than in each caller hoping to
 * remember.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { type Files } from "./actions.ts"

/**
 * `~` means the user's home, on every platform.
 *
 * It does not for `path.resolve`, which treats it as an ordinary directory name
 * — so `~/tasks.md` would silently become `<root>/~/tasks.md`, which fails with
 * a message about a file nobody can find. Typed constantly, and obviously meant
 * to work.
 */
export function expandHome(value: string, home = process.env.HOME ?? process.env.USERPROFILE ?? ""): string {
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value
  if (!home) throw new Error("cannot expand ~: no home directory is set")
  return path.join(home, value.slice(2))
}

/** Confine a project-relative path to the project. */
export function resolveInside(root: string, relative: string, options: { allowAbsolute?: boolean } = {}): string {
  const expanded = expandHome(relative)
  // Windows separators are normalised here so a path copied off a Windows
  // machine means the same thing on a Linux box.
  const unixish = expanded.replace(/\\/g, "/")
  if (options.allowAbsolute && (path.posix.isAbsolute(unixish) || /^[A-Za-z]:\//.test(unixish))) {
    return path.normalize(unixish)
  }
  if (path.isAbsolute(expanded) || path.posix.isAbsolute(unixish) || /^[A-Za-z]:\//.test(unixish)) {
    throw new Error(`path must be relative to the project root: ${relative}`)
  }
  const normalised = path.normalize(expanded)
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, normalised)
  // `path.resolve` has already collapsed any `..`, so a prefix test is exact:
  // it cannot be fooled by `a/../../b`, and it cannot match a sibling
  // directory that merely shares a name prefix (`/proj` vs `/project`).
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`path leaves the project root: ${relative}`)
  }
  return target
}

/**
 * Project file access.
 *
 * `absolute` is set only by the human-facing import path, and only ever reaches
 * `read`. See `confinePath` in actions.ts for why the two callers differ: a
 * person naming a file is an instruction, a tool call is a suggestion.
 */
export function projectFiles(root: string, options: { allowAbsoluteRead?: boolean } = {}): Files {
  return {
    async read(relative) {
      return readFile(resolveInside(root, relative, { allowAbsolute: options.allowAbsoluteRead }), "utf8")
    },
    async write(relative, content) {
      const target = resolveInside(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    },
  }
}