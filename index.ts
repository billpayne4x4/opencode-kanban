/**
 * Root entry point.
 *
 * OpenCode discovers plugin package directories and loads a root `index.ts`
 * from them, so this file exists so that both discovery and the `exports` map
 * point at the same place. The implementation lives in `src/`.
 */
export { default } from "./src/index.ts"