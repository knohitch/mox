#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const EXCLUDED_PARTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "third_party",
]);

const ACTIVE_ROOTS = new Set([
  ".github",
  "apps",
  "docs",
  "infra",
  "packages",
  "runtime",
  "scripts",
  "services",
]);

const ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
]);

const TEXT_EXTENSIONS = new Set([
  ".cmd",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const TOKEN_PATTERNS = [
  { name: "AWS access key", pattern: /\b(A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/g },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{40,}\b/g },
  { name: "Stripe secret key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "Private key header", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

const ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|secret|password|token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']([^"']{20,})["']/gi;

function isExcluded(path) {
  return path.split(/[\\/]+/).some((part) => EXCLUDED_PARTS.has(part));
}

function isActiveReleaseFile(path) {
  const first = path.split(/[\\/]+/)[0];
  return ACTIVE_ROOTS.has(first) || ROOT_FILES.has(path);
}

function extensionOf(path) {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx).toLowerCase();
}

function looksLikePlaceholder(value) {
  return /^(test|fake|demo|example|placeholder|changeme|not[-_]?set|redacted|vault:\/\/)/i.test(value)
    || /(test|fake|demo|example|placeholder|redacted|fixture|dummy)/i.test(value);
}

function entropyish(value) {
  const unique = new Set(value).size;
  return unique >= 12 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

const findings = [];

for (const file of trackedFiles()) {
  if (!isActiveReleaseFile(file)) continue;
  if (isExcluded(file)) continue;
  const ext = extensionOf(file);
  if (ext && !TEXT_EXTENSIONS.has(ext)) continue;
  if (!ext && !/(^|\/)(Dockerfile|LICENSE|NOTICE)$/i.test(file)) continue;

  let text;
  try {
    text = await readFile(join(ROOT, file), "utf8");
  } catch {
    continue;
  }

  for (const rule of TOKEN_PATTERNS) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({ file, line: lineNumber(text, match.index ?? 0), rule: rule.name });
    }
  }

  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    const value = match[1] ?? "";
    if (looksLikePlaceholder(value)) continue;
    if (!entropyish(value)) continue;
    findings.push({ file, line: lineNumber(text, match.index ?? 0), rule: "high-entropy secret assignment" });
  }
}

if (findings.length > 0) {
  console.error("secret-scan: failed");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
  }
  process.exit(1);
}

console.log("secret-scan: clean");
