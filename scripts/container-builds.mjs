#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const ACTIVE_ROOTS = new Set(["apps", "infra", "packages", "runtime", "services"]);

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

const files = trackedFiles();
const activeFiles = files.filter((file) => ACTIVE_ROOTS.has(file.split(/[\\/]+/)[0]));
const dockerfiles = activeFiles.filter((file) => /(^|\/)Dockerfile(?:\..+)?$/i.test(file));
const composeFiles = activeFiles.filter((file) => /(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(file));

if (dockerfiles.length === 0 && composeFiles.length === 0) {
  console.log("container-builds: no container build files configured");
  process.exit(0);
}

for (const file of dockerfiles) {
  const context = dirname(file);
  const args = ["build", "-f", file, join(ROOT, context)];
  console.log(`container-builds: docker ${args.join(" ")}`);
  const result = spawnSync("docker", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of composeFiles) {
  const args = ["compose", "-f", file, "build"];
  console.log(`container-builds: docker ${args.join(" ")}`);
  const result = spawnSync("docker", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `container-builds: built ${dockerfiles.length} Dockerfile(s) and ${composeFiles.length} compose project(s)`,
);
