import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Security Repair 07 — production computer composition", () => {
  it("E5: the production computer snapshot endpoint remains fail-closed/not_configured", async () => {
    const source = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
    const route = source.match(
      /router\.get\("\/api\/computer\/:agentId\/snapshot"[\s\S]*?\n\s*}\);/,
    )?.[0];
    expect(route).toBeDefined();
    expect(route).toContain("requireAuth(ctx, \"servers\")");
    expect(route).toContain("requireCommercialMutation(identity, \"browser_sessions\"");
    expect(route).toContain("501");
    expect(route).toContain('code: "not_configured"');
    expect(route).not.toContain("new ComputerGateway");
  });
});
