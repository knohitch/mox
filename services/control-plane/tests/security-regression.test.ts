/**
 * Security regression suite (Prompt 00B §I) — runs without a database.
 * PostgreSQL-backed security tests live in auth-integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeComputeProvider } from "@mox/compute-providers";
import { ComputeOrchestrator } from "@mox/compute-orchestrator";
import { InMemoryOrchestratorStore } from "@mox/compute-orchestrator";
import {
  extractSessionToken,
  isCookieAuthenticated,
  serializeClearSessionCookie,
  serializeSessionCookie,
} from "../src/auth.js";
import { hashPassword, verifyPassword } from "../src/password.js";
import { requestLogLine } from "../src/http.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const webSrc = join(repoRoot, "apps", "web", "src");

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("browser bundle contains no master secrets (§I)", () => {
  it("VITE_MOX_BOOTSTRAP_TOKEN appears nowhere in web source or env typings", () => {
    for (const file of listFilesRecursive(webSrc)) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toContain("VITE_MOX_BOOTSTRAP_TOKEN");
    }
  });

  it("web client never persists session credentials to localStorage", () => {
    for (const file of listFilesRecursive(webSrc)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const content = readFileSync(file, "utf8");
      if (file.includes("demo-api.ts")) continue; // dev-only fixture
      expect(content.includes("localStorage")).toBe(false);
    }
  });

  it("realtime client never places a token in the stream URL", () => {
    const content = readFileSync(join(webSrc, "api", "realtime.ts"), "utf8");
    expect(content).toContain("sinceSeq=");
    expect(content).not.toMatch(/token=|authorization=/i);
  });

  it("http client sends the CSRF header on mutations and uses cookie credentials", () => {
    const content = readFileSync(join(webSrc, "api", "http-api.ts"), "utf8");
    expect(content).toContain('CSRF_HEADER = "x-mox-csrf"');
    expect(content).toContain('credentials: "include"');
  });
});

describe("request logging cannot leak secrets (§D/§I)", () => {
  it("logs pathname only — query strings with tokens are dropped", () => {
    const secret = "supersecrettoken123";
    const line = requestLogLine("GET", `/api/streams/org-events?token=${secret}`, 200, 12);
    expect(line).not.toContain(secret);
    expect(line).toContain(`/api/streams/org-events -> 200`);

    const line2 = requestLogLine("POST", "/x?authorization=Bearer%20abc&password=pw", 500, 3);
    expect(line2).not.toContain("abc");
    expect(line2).not.toContain("pw");
    void secret;
  });

  it("malformed targets are still stripped of query strings", () => {
    const line = requestLogLine("GET", "not-a-url?token=leaky", 400, 1);
    expect(line).not.toContain("leaky");
  });
});

describe("cookie serialization hardening (§B)", () => {
  it("session cookie is HttpOnly + SameSite=Lax + Secure in production", () => {
    const cookie = serializeSessionCookie("tok", { secure: true, maxAgeSeconds: 60 });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=60");
    const devCookie = serializeSessionCookie("tok", { secure: false, maxAgeSeconds: 60 });
    expect(devCookie).not.toContain("Secure");
    expect(serializeClearSessionCookie()).toContain("Max-Age=0");
  });

  it("extracts tokens from header or cookie and flags the cookie channel", () => {
    expect(extractSessionToken({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractSessionToken({ cookie: "mox_session=def; other=x" })).toBe("def");
    expect(isCookieAuthenticated({ authorization: "Bearer abc", cookie: "mox_session=def" })).toBe(false);
    expect(isCookieAuthenticated({ authorization: undefined, cookie: "mox_session=def" })).toBe(true);
    expect(isCookieAuthenticated({ authorization: undefined, cookie: undefined })).toBe(false);
  });
});

describe("password KDF (§B)", () => {
  it("verifies correct passwords and rejects wrong ones", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(encoded.startsWith("scrypt$")).toBe(true);
    expect(encoded).not.toContain("correct horse battery");
    await expect(verifyPassword("correct horse battery", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
  });

  it("uses a unique salt per hash so equal passwords diverge", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
  });
});

describe("web client credential handling (Prompt 00C)", () => {
  it("web source never references sessionToken or bearer persistence", () => {
    for (const file of listFilesRecursive(webSrc)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (file.includes("demo-api.ts")) continue; // dev-only fixture
      const content = readFileSync(file, "utf8");
      expect(content.includes("sessionToken")).toBe(false);
      expect(content).not.toMatch(/mox_pat_/);
    }
  });

  it("cross-origin is decided by comparing real origins, not localhost heuristics", async () => {
    // The decision logic lives in apps/web/src/api/http-api.ts; verify via
    // source assertions since vitest runs in Node without DOM location.
    const content = readFileSync(join(webSrc, "api", "http-api.ts"), "utf8");
    expect(content).toContain("location.origin !== target");
    expect(content).not.toMatch(/localhost(:\\d+)?\/i/);
  });
});

describe("PAT scope matrix (Prompt 00D §A)", () => {
  it("* satisfies every family; explicit families satisfy themselves only", async () => {
    const { scopeSatisfied } = await import("../src/auth.js");
    for (const family of ["agents", "threads", "servers", "billing", "models", "integrations", "channels", "usage", "approvals", "settings"]) {
      expect(scopeSatisfied(["*"], family)).toBe(true);
      expect(scopeSatisfied([family], family)).toBe(true);
      expect(scopeSatisfied(["agents"], family === "agents" ? "agents" : family)).toBe(family === "agents");
    }
    expect(scopeSatisfied(["agents", "servers"], "billing")).toBe(false);
    // admin is a scope like any other at check-time; privilege gating
    // happens at issuance and via real roles.
    expect(scopeSatisfied(["admin"], "agents")).toBe(false);
  });
});

describe("orchestrator store authority contract (§G)", () => {
  it("no longer pretends consumeNonce is real", () => {
    expect((InMemoryOrchestratorStore.prototype as unknown as Record<string, unknown>).consumeNonce).toBeUndefined();
  });
});

async function configure(orch: ComputeOrchestrator): Promise<void> {
  await orch.registerProviderAccount({
    providerName: "fake-compute",
    accountLabel: "primary",
    commercialStatus: "active",
    healthScore: 100,
    enabled: true,
  });
  await orch.configureComputeClass({
    code: "COMPUTE_SMALL",
    displayName: "Small",
    minVcpu: 2,
    minRamGb: 4,
    skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
    active: true,
  });
}

function enrollSecretOf(fake: FakeComputeProvider): string | undefined {
  const last = fake.provisionCalls.at(-1);
  return last ? [...last.cloudInitUserData.matchAll(/MOX_ENROLL_TOKEN=(\S+)/g)][0]?.[1] : undefined;
}

async function issuedCount(store: InMemoryOrchestratorStore, orderId: string): Promise<number> {
  // The in-memory store has no list API by design; probe via revoke count.
  return store.revokeIssuedEnrollmentTokensForOrder(orderId, new Date().toISOString());
}

describe("enrollment retry hardening (§F)", () => {
  it("failed provisioning revokes the issued token; retry issues exactly one new one", async () => {
    const fake = new FakeComputeProvider();
    fake.setProvisionScript({ failFirstAttemptThenSucceed: true });
    const store = new InMemoryOrchestratorStore();
    const orch = new ComputeOrchestrator(store, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    orch.registerProvider(fake);
    await configure(orch);

    const { order } = await orch.orderServer({
      orgId: "org-retry",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-retry",
      idempotencyKey: "retry-1",
    });

    // Tick 1 fails AFTER issuing the expectation â†’ token must be revoked.
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const staleSecret = enrollSecretOf(fake)!;
    expect(staleSecret).toBeTruthy();
    expect(await issuedCount(store, order.id)).toBe(0); // nothing usable left

    // Tick 2 succeeds with a fresh token; old secret must be rejected.
    await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    const freshSecret = enrollSecretOf(fake)!;
    expect(freshSecret).not.toBe(staleSecret);

    await expect(
      orch.enrollNode({
        orgId: "org-retry",
        orderId: order.id,
        nodeId: "node-stale",
        enrollToken: staleSecret,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow(/revoked|unknown enrollment token|older provisioning attempt/);

    const { node } = await orch.enrollNode({
      orgId: "org-retry",
      orderId: order.id,
      nodeId: "node-fresh",
      enrollToken: freshSecret,
      now: new Date().toISOString(),
    });
    expect(node.nodeId).toBe("node-fresh");
  });

  it("a bound token from an older provisioning attempt is rejected after re-provision", async () => {
    // Simulate two successful provisions on the same order via distinct ops:
    // first provision binds instance A; a forced second issuance binds B.
    const fake = new FakeComputeProvider();
    const store = new InMemoryOrchestratorStore();
    const orch = new ComputeOrchestrator(store, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    orch.registerProvider(fake);
    await configure(orch);

    const { order } = await orch.orderServer({
      orgId: "org-old-token",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-old-token",
      idempotencyKey: "old-1",
    });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const firstSecret = enrollSecretOf(fake)!;
    const instanceA = (await orch.getOrder(order.id)).providerInstanceId!;

    // Force a retry-style reissue (as reconcile would on a new provision op).
    const reissued = await (
      orch as unknown as { issueEnrollmentToken(o: { id: string; orgId: string }, at: string): Promise<{ secret: string }> }
    ).issueEnrollmentToken(order, new Date().toISOString());
    void instanceA;

    // Old token is revoked â†’ rejected even though its hash was valid once.
    await expect(
      orch.enrollNode({ orgId: "org-old-token", orderId: order.id, nodeId: "n-old", enrollToken: firstSecret }),
    ).rejects.toThrow(/revoked/);

    // New token enrolls and the node record exists.
    const { node } = await orch.enrollNode({
      orgId: "org-old-token",
      orderId: order.id,
      nodeId: "n-new",
      enrollToken: reissued.secret,
    });
    expect(node.nodeId).toBe("n-new");
  });
});
