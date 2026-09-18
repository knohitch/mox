import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("CapRover captain-definition", () => {
  it("exists at the repository root as schemaVersion 2 JSON pointing at ./Dockerfile", () => {
    const raw = readFileSync(join(ROOT, "captain-definition"), "utf8");
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    const definition = JSON.parse(raw) as { schemaVersion?: number; dockerfilePath?: string };
    expect(definition.schemaVersion).toBe(2);
    expect(definition.dockerfilePath).toBe("./Dockerfile");
  });
});
