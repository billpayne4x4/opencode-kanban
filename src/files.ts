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

/** Confine a project-relative path to the project. */
export function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`path must be relative to the project root: ${relative}`)
  const normalised = path.normalize(relative)
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

export function projectFiles(root: string): Files {
  return {
    async read(relative) {
      return readFile(resolveInside(root, relative), "utf8")
    },
    async write(relative, content) {
      const target = resolveInside(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    },
  }
}