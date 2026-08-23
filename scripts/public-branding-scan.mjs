#!/usr/bin/env node
/**
 * Public branding scan.
 *
 * Fails when customer-facing source/docs/templates expose legacy donor
 * product names or generic GPT wording. Third-party license, notice and
 * provenance records are intentionally excluded; they are the approved place
 * for legal attribution.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  "README.md",
  "apps/web",
  "apps/admin",
  "apps/cli",
  "runtime",
  "services/control-plane/src",
  "services/notification-service/src",
  "services/agent-control/src",
  "services/audit-service/src",
  "packages/runtime-client/src",
  "packages/contracts/src",
  "docs/architecture",
  "docs/operations",
  "docs/security",
  "docs/verification",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".vite",
]);

const SKIP_PATH_PARTS = [
  ["third_party", "licenses"],
  ["third_party", "notices"],
  ["third_party", "provenance"],
  ["docs", "consolidation"],
  ["docs", "legal"],
  ["docs", "provenance"],
];

const ALLOWED_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const DONOR_RULES = [
  { name: "forbidden donor product name", pattern: /\bOpenBot\b/i },
  { name: "forbidden donor product name", pattern: /\bOpenMausBot\b/i },
  { name: "forbidden donor product name", pattern: /\bGrokBot\b/i },
  { name: "forbidden donor runtime name", pattern: /\bDeepSeek\s+Harness\b/i },
  { name: "forbidden donor runtime shorthand", pattern: /\bDSH\b/ },
  { name: "forbidden donor snapshot path", pattern: /\bdeepseek-harness(?:-master)?\b/i },
  { name: "forbidden donor snapshot path", pattern: /\bOpenBot-main\b/i },
  { name: "forbidden donor snapshot path", pattern: /\bOpenMausBot-main\b/i },
];

const GENERIC_GPT_RULES = [
  { name: "generic GPT agent wording", pattern: /\bGPT\s+agent\b/i },
  { name: "generic GPT powered wording", pattern: /\bGPT[-\s]+powered\b/i },
  { name: "generic GPT settings wording", pattern: /\bGPT\s+settings\b/i },
];

const ALLOWED_GPT_CONTEXT =
  /\b(OpenAI|provider|providerId|model|modelId|ModelId|displayName|identifier|quota|cost|availability|gpt-[a-z0-9][a-z0-9._-]*)\b/i;

function hasPathParts(path, parts) {
  const normalized = path.split(/[\\/]+/);
  for (let i = 0; i <= normalized.length - parts.length; i += 1) {
    if (parts.every((part, offset) => normalized[i + offset] === part)) return true;
  }
  return false;
}

function isSkippedPath(path) {
  const rel = relative(root, path);
  return SKIP_PATH_PARTS.some((parts) => hasPathParts(rel, parts));
}

function* walk(path) {
  if (!existsSync(path) || isSkippedPath(path)) return;
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(join(path, entry));
    }
    return;
  }
  if (ALLOWED_EXTENSIONS.has(extname(path))) yield path;
}

function scanLine(file, line, lineNumber, violations) {
  for (const rule of DONOR_RULES) {
    if (rule.pattern.test(line)) {
      violations.push({ file, lineNumber, rule: rule.name, text: line.trim() });
    }
  }

  for (const rule of GENERIC_GPT_RULES) {
    if (rule.pattern.test(line)) {
      violations.push({ file, lineNumber, rule: rule.name, text: line.trim() });
    }
  }

  const withoutModelIds = line.replace(/\bgpt-[a-z0-9][a-z0-9._-]*\b/gi, "");
  if (/\bGPT\b/i.test(withoutModelIds) && !ALLOWED_GPT_CONTEXT.test(line)) {
    violations.push({
      file,
      lineNumber,
      rule: "generic GPT wording outside provider/model context",
      text: line.trim(),
    });
  }
}

const violations = [];
for (const target of TARGETS) {
  const full = join(root, target);
  for (const file of walk(full)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => scanLine(file, line, idx + 1, violations));
  }
}

if (violations.length > 0) {
  console.error("public-branding-scan: failed");
  for (const violation of violations) {
    const file = relative(root, violation.file).split(sep).join("/");
    console.error(`  ${file}:${violation.lineNumber} ${violation.rule}`);
    console.error(`    ${violation.text.slice(0, 180)}`);
  }
  process.exit(1);
}

console.log("public-branding-scan: clean — public surfaces use Mox branding");
