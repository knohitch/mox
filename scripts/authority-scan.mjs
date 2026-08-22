#!/usr/bin/env node
/**
 * Authority scan (Prompt 15): fails when Mox-owned production code imports
 * from the vendored upstream trees. Vendored trees are reference-only.
 *
 * Usage: node scripts/authority-scan.mjs   (exit 0 = clean, 1 = violations)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["apps", "services", "runtime", "packages", "infra"];
const FORBIDDEN = [/OpenBot-main/, /OpenMausBot-main/, /deepseek-harness-master/];
const IMPORT_RE = /(?:import|require|from)\s*[^;]*?(?:OpenBot-main|OpenMausBot-main|deepseek-harness-master)/;
const ALLOWED_EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".json"]);

/** Doc/comment mentions are fine; only real import/require paths violate. */
function scan(dir, violations) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      scan(full, violations);
    } else if (ALLOWED_EXT.has(extname(entry))) {
      const text = readFileSync(full, "utf8");
      if (IMPORT_RE.test(text)) {
        // Distinguish prose mentions from actual module specifiers.
        for (const line of text.split("\n")) {
          if (IMPORT_RE.test(line) && /['"`]/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//")) {
            violations.push({ file: full, line: line.trim().slice(0, 160) });
            break;
          }
        }
      }
      void FORBIDDEN;
    }
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  scan(join(root, dir), violations);
}

if (violations.length > 0) {
  console.error("AUTHORITY SCAN FAILED — vendored tree imported from production code:");
  for (const v of violations) {
    console.error(`  ${v.file}\n    ${v.line}`);
  }
  process.exit(1);
}
console.log("authority-scan: clean — no vendored-tree imports in Mox production code");
