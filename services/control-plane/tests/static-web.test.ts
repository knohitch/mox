import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReservedControlPlanePath, resolveWebFile } from "../src/static-web.js";

describe("control-plane static SPA hosting", () => {
  it("keeps API, webhook and health paths off the SPA rewrite", () => {
    expect(isReservedControlPlanePath("/healthz")).toBe(true);
    expect(isReservedControlPlanePath("/api/me")).toBe(true);
    expect(isReservedControlPlanePath("/webhooks/billing/stripe")).toBe(true);
    expect(isReservedControlPlanePath("/login")).toBe(false);
    expect(isReservedControlPlanePath("/")).toBe(false);
  });

  it("serves hashed assets and rewrites extensionless routes to index.html", async () => {
    const dist = await mkdtemp(join(tmpdir(), "mox-web-dist-"));
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "index.html"), "<!doctype html><title>Mox</title>");
    await writeFile(join(dist, "assets", "app.js"), "console.log('ok')");

    const root = await resolveWebFile(dist, "/");
    expect(root?.filePath).toBe(join(dist, "index.html"));
    expect(root?.contentType).toContain("text/html");
    expect(root?.cacheControl).toBe("no-store");

    const spa = await resolveWebFile(dist, "/login");
    expect(spa?.filePath).toBe(join(dist, "index.html"));

    const asset = await resolveWebFile(dist, "/assets/app.js");
    expect(asset?.filePath).toBe(join(dist, "assets", "app.js"));
    expect(asset?.contentType).toContain("javascript");
  });

  it("rejects path traversal and missing hashed files", async () => {
    const dist = await mkdtemp(join(tmpdir(), "mox-web-dist-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");

    expect(await resolveWebFile(dist, "/../../etc/passwd")).toBeNull();
    expect(await resolveWebFile(dist, "/assets/missing.js")).toBeNull();
    expect(await resolveWebFile(dist, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });
});
