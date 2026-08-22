import { describe, expect, it } from "vitest";
import { ContaboClient, ContaboProvider, UnconfiguredComputeProvider, contaboProviderFromEnv } from "../src/contabo.js";
import { FakeComputeProvider } from "../src/fake.js";
import { HetznerProvider, UnconfiguredHetzner, hetznerProviderFromEnv } from "../src/hetzner.js";
import { ProviderError } from "../src/types.js";

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const CONTABO_CREDS = { clientId: "cid", clientSecret: "cs" };

describe("contabo adapter", () => {
  it("authenticates once and sends bearer + X-Request-Id headers", async () => {
    const seen: Array<{ auth?: string; requestId?: string; url: string; method: string }> = [];
    let tokenCalls = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://auth.contabo.com")) {
        tokenCalls += 1;
        return jsonRes(200, { access_token: "tok-1", expires_in: 3600 });
      }
      seen.push({ auth: headers.get("authorization") ?? undefined, requestId: headers.get("x-request-id") ?? undefined, url, method: init?.method ?? "GET" });
      return jsonRes(200, { data: [] });
    };
    const client = new ContaboClient(CONTABO_CREDS, { fetchImpl });
    await client.request("GET", "/v1/compute/plans", { requestId: "mox-key-1" });
    await client.request("GET", "/v1/compute/locations");
    expect(tokenCalls).toBe(1);
    expect(seen[0]?.auth).toBe("Bearer tok-1");
    expect(seen[0]?.requestId).toBe("mox-key-1");
    expect(seen[1]?.requestId).toBeTruthy();
  });

  it("retries 429 honoring Retry-After then succeeds", async () => {
    let calls = 0;
    let slept = 0;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).startsWith("https://auth.contabo.com")) {
        return jsonRes(200, { access_token: "t", expires_in: 3600 });
      }
      calls += 1;
      if (calls === 1) return jsonRes(429, {}, { "retry-after": "2" });
      return jsonRes(200, { data: [{ productId: 42, displayName: "Cloud 2", cpu: 2, ram: 4, disk: 40 }] });
    };
    const client = new ContaboClient(CONTABO_CREDS, { fetchImpl, sleep: async (ms) => { slept = ms; } });
    const plans = await client.request<{ data: Array<{ productId: number }> }>("GET", "/v1/compute/plans");
    expect(calls).toBe(2);
    expect(slept).toBe(2000);
    expect(plans.data[0]?.productId).toBe(42);
  });

  it("normalizes non-retryable HTTP errors into ProviderError", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).startsWith("https://auth.contabo.com")) {
        return jsonRes(200, { access_token: "t", expires_in: 3600 });
      }
      return jsonRes(403, { error: "forbidden" });
    };
    const client = new ContaboClient(CONTABO_CREDS, { fetchImpl, maxRetries: 1 });
    await expect(client.request("GET", "/v1/compute/plans")).rejects.toBeInstanceOf(ProviderError);
  });

  it("provisions with base64 cloud-init user data and maps instance state", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("https://auth.contabo.com")) {
        return jsonRes(200, { access_token: "t", expires_in: 3600 });
      }
      if (init?.method === "POST" && url.endsWith("/v1/compute/instances")) {
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonRes(201, { data: [{ instanceId: 7777, status: "installing", regionName: "EU", createdDate: "2026-08-21T00:00:00Z" }] });
      }
      return jsonRes(200, { data: [] });
    };
    const provider = new ContaboProvider(
      CONTABO_CREDS,
      { defaultImageId: 99 },
      { fetchImpl },
    );
    const result = await provider.provision({
      idempotencyKey: "abc123",
      regionCode: "EU",
      providerSku: "102",
      hostname: "srv-1",
      sshPublicKey: "ssh-ed25519 AAAA",
      cloudInitUserData: "#cloud-init\nmox_node_enroll: yes",
    });
    expect(result.instance.state).toBe("provisioning");
    expect(Buffer.from(String(capturedBody?.userData), "base64").toString()).toContain("mox_node_enroll");
    expect(capturedBody?.imageId).toBe(99);
    expect(capturedBody?.sshKeys).toEqual(["ssh-ed25519 AAAA"]);
  });
});

describe("hetzner adapter", () => {
  it("is commercially gated at verify by default and refuses production routing", async () => {
    const provider = new HetznerProvider({ apiToken: "tok" }, {
      fetchImpl: async () => jsonRes(200, { locations: [], server_types: [] }),
    });
    expect(provider.configured).toBe(true);
    expect(provider.commercialStatus).toBe("verify");
    // Orchestrator contract: only approved providers may take production traffic.
    const productionEligible = provider.commercialStatus === "approved";
    expect(productionEligible).toBe(false);
  });

  it("reports unconfigured honestly without HETZNER_API_TOKEN", () => {
    const provider = hetznerProviderFromEnv({});
    expect(provider.configured).toBe(false);
    expect(provider.blocker).toContain("HETZNER_API_TOKEN");
    expect(provider).toBeInstanceOf(UnconfiguredHetzner);
    void hetznerProviderFromEnv;
  });

  it("maps provision responses to canonical instances", async () => {
    const provider = new HetznerProvider({ apiToken: "tok" }, {
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") {
          return jsonRes(201, {
            server: {
              id: 42,
              name: "srv-1",
              status: "initializing",
              server_type: { name: "cx22" },
              datacenter: { location: { name: "fsn1" } },
              public_net: { ipv4: { ip: "203.0.113.10" } },
            },
            action: { id: 9, status: "running" },
          });
        }
        return jsonRes(200, {});
      },
    });
    const result = await provider.provision({
      idempotencyKey: "k",
      regionCode: "fsn1",
      providerSku: "cx22",
      hostname: "srv-1",
      sshPublicKey: "ssh",
      cloudInitUserData: "#cloud-init",
    });
    expect(result.instance.providerInstanceId).toBe("42");
    expect(result.instance.state).toBe("provisioning");
    expect(result.operation.status).toBe("running");
  });
});

describe("fake compute provider", () => {
  it("detects duplicate provisioning requests via the call log", async () => {
    const fake = new FakeComputeProvider();
    const input = {
      idempotencyKey: "order-1-attempt-1",
      regionCode: "fsn1",
      providerSku: "CX22",
      hostname: "srv-1",
      sshPublicKey: "ssh",
      cloudInitUserData: "",
    };
    await fake.provision(input);
    await fake.provision(input);
    // Two raw calls happened — the ORCHESTRATOR must prevent this; the fake
    // exposes the log so tests can assert dedupe upstream.
    expect(fake.provisionCalls).toHaveLength(2);
    expect(fake.instances.size).toBe(2);
  });

  it("supports fail-first-then-succeed scripts for late-success retries", async () => {
    const fake = new FakeComputeProvider();
    fake.setProvisionScript({ failFirstAttemptThenSucceed: true });
    const input = { idempotencyKey: "k1", regionCode: "ash", providerSku: "CX32", hostname: "h", sshPublicKey: "s", cloudInitUserData: "" };
    await expect(fake.provision(input)).rejects.toMatchObject({ retryable: true });
    const second = await fake.provision(input);
    expect(second.instance.state).toBe("running");
  });
});

describe("provider factories", () => {
  it("contabo env factory reports missing credentials as a blocker", () => {
    const provider = contaboProviderFromEnv({});
    expect(provider.configured).toBe(false);
    expect(provider.blocker).toContain("CONTABO_CLIENT_ID");
    expect(provider).toBeInstanceOf(UnconfiguredComputeProvider);
  });
});
