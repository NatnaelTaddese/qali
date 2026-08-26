/**
 * Minimal declaration of the one Vite-provided global the tests use.
 * vitest supplies the real implementation; vite itself is not a direct
 * dependency, so its bundled client types are not resolvable here.
 */
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
