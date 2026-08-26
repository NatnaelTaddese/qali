/// <reference types="vite/client" />

/**
 * Shared convex-test module map. Vite's import.meta.glob keys each match by
 * its shortest relative path from the importing file, so a glob written inside
 * a domain directory keys same-directory modules as "./x.ts" while convex-test
 * resolves function paths against the convex-root prefix — nested modules like
 * "domains/sync/engine" then fail to resolve. Globbing from one level above
 * convex/ keeps every key on the same "./convex/" prefix.
 */
export const modules = import.meta.glob("./convex/**/*.ts");
