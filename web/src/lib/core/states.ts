import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * ACL for templates/states.yml — the SINGLE SOURCE OF TRUTH for canonical
 * application states (career-ops writer + dashboard reader both read it). Per the
 * web↔core contract we READ it live and never hardcode the list.
 */
export type CanonicalState = {
  id: string;
  label: string;
  aliases: string[];
  description: string;
  group: string;
};

let cache: CanonicalState[] | null = null;

export function readCanonicalStates(): CanonicalState[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(path.join(careerOpsRoot(), "templates", "states.yml"), "utf8");
    const doc = yaml.load(raw) as { states?: unknown };
    const list = Array.isArray(doc?.states) ? doc.states : null;
    if (list && list.length) {
      const parsed: CanonicalState[] = [];
      for (const s of list as Record<string, unknown>[]) {
        if (!s || typeof s.label !== "string") continue;
        parsed.push({
          id: typeof s.id === "string" ? s.id : s.label.toLowerCase(),
          label: s.label,
          aliases: Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === "string") : [],
          description: typeof s.description === "string" ? s.description : "",
          group: typeof s.dashboard_group === "string" ? s.dashboard_group : (typeof s.id === "string" ? s.id : s.label.toLowerCase()),
        });
      }
      if (parsed.length) {
        cache = parsed;
        return parsed;
      }
    }
  } catch {
    /* fall through to fallback */
  }
  cache = [];
  return cache;
}

export function canonicalLabels(): string[] {
  return readCanonicalStates().map((s) => s.label);
}

/** Map any raw status (label/id/alias, case-insensitive) to its canonical label,
 *  or null if unrecognized. */
export function canonicalizeStatus(raw: string): string | null {
  const q = raw.trim().toLowerCase().replace(/\*\*/g, "");
  if (!q) return null;
  for (const s of readCanonicalStates()) {
    if (s.label.toLowerCase() === q || s.id.toLowerCase() === q || s.aliases.some((a) => a.toLowerCase() === q)) {
      return s.label;
    }
  }
  return null;
}
