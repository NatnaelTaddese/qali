/**
 * Enforces that no new source emits the pre-cutover root-facade paths
 * (MIGRATION_RUNBOOK.md section 7): everything must reference the canonical
 * `domains/`, `jobs/`, and `migrations/` registrations. Comments are stripped
 * before matching, so drain annotations that name legacy paths stay legal;
 * only code (including string literals) can violate. Files that must keep a
 * legacy reference are allowlisted below with the reason.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Anchored on the backend package dir so the test is cwd-independent.
const BACKEND_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOTS = [
  join(BACKEND_DIR, "convex"),
  join(BACKEND_DIR, "..", "..", "apps", "web", "src"),
  join(BACKEND_DIR, "..", "..", "apps", "www", "src"),
];

// Longest-first so the reported module name is the one actually referenced.
const LEGACY_PATH =
  /\b(?:api|internal)\.(?:assistantMaintenance|assistantData|assistant|backfillConnections|calendarSync|calendar|booking|maintenance|notifications|people|waitlist)\./g;

// Relative to BACKEND_DIR. Each entry keeps a deliberate legacy reference.
const ALLOWLIST = new Map<string, string>([
  ["convex/googleSync.ts", "frozen drain shim, removed with wave 2"],
  ["convex/domains/sync/googleCompat.ts", "frozen drain shim, removed with wave 2"],
  [
    "convex/migrations/scheduledJobs.ts",
    "seeds the legacy path for the preview rehearsal",
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Remove line and block comments while respecting string and template
 * literals (including nested `${}` interpolations). Newlines are preserved so
 * match indexes still map to source line numbers. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "single" | "double" | "template" =
    "code";
  // Brace depth at each open `${`, so a template resumes when its expression's
  // closing brace arrives at the recorded depth.
  const templateStack: number[] = [];
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        i += 2;
      } else if (ch === "/" && next === "*") {
        mode = "block";
        i += 2;
      } else {
        if (ch === "'") mode = "single";
        else if (ch === '"') mode = "double";
        else if (ch === "`") mode = "template";
        else if (ch === "{") braceDepth += 1;
        else if (ch === "}") {
          if (
            templateStack.length > 0 &&
            braceDepth === templateStack[templateStack.length - 1]
          ) {
            templateStack.pop();
            mode = "template";
          } else {
            braceDepth -= 1;
          }
        }
        out += ch;
        i += 1;
      }
    } else if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
      i += 1;
    } else if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i += 2;
      } else {
        if (ch === "\n") out += ch;
        i += 1;
      }
    } else if (mode === "single" || mode === "double") {
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 2;
      } else {
        if (ch === (mode === "single" ? "'" : '"') || ch === "\n") {
          mode = "code";
        }
        out += ch;
        i += 1;
      }
    } else {
      // template
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 2;
      } else if (ch === "`") {
        mode = "code";
        out += ch;
        i += 1;
      } else if (ch === "$" && next === "{") {
        templateStack.push(braceDepth);
        mode = "code";
        out += "${";
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
    }
  }
  return out;
}

describe("no legacy facade paths", () => {
  test("source references only canonical function paths", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        const rel = relative(BACKEND_DIR, file);
        if (ALLOWLIST.has(rel)) continue;
        // Test files are exercised paths, not emitting source; the ones that
        // reference legacy paths deliberately are allowlisted above.
        if (/\.(test|itest)\.tsx?$/.test(file)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        for (const match of code.matchAll(LEGACY_PATH)) {
          const line = code.slice(0, match.index).split("\n").length;
          violations.push(`${rel}:${line} ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
