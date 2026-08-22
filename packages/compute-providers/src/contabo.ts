/**
 * Contabo adapter (Prompt 09) — the first real compute provider.
 *
 * Talks to https://api.contabo.com with OAuth2 client-credentials, sends
 * `X-Request-Id` on every call (derived from Mox idempotency keys where a
 * caller provides one), normalizes errors into ProviderError with honest
 * retry semantics, backs off on 429 honoring Retry-After, and never leaks
 * wholesale cost data above this layer.
 */

import type {
  ComputeCapabilities,
  ComputeProvider,
  ProviderInstance,
  ProviderOperation,
  ProviderProduct,
  ProviderRegion,
  ProvisionInput,
} from "./types.js";
import { capabilitiesWith, ProviderError } from "./types.js";

export interface ContaboCredentials {
  clientId: string;
  clientSecret: string;
  apiUrl?: string;
  authUrl?: string;
}

export interface ContaboOptions {
  /** Minimum spacing between API calls; Contabo throttles ~1 rps. */
  minIntervalMs?: number;
  maxRetries?: number;
  /** Injectable fetch for unit tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API_URL = "https://api.contabo.com";
const DEFAULT_AUTH_URL = "https://auth.contabo.com/token";

interface TokenState {
  accessToken: string;
  expiresAtMs: number;
}

export class ContaboClient {
  private readonly http: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private token?: TokenState;
  private lastCallAt = 0;

  constructor(
    private readonly creds: ContaboCredentials,
    options: ContaboOptions = {},
  ) {
    this.http = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.maxRetries = options.maxRetries ?? 4;
  }

  private async getToken(): Promise<string> {
    const skewMs = 30_000;
    if (this.token && this.token.expiresAtMs - skewMs > this.now()) {
      return this.token.accessToken;
    }
    const res = await this.http(this.creds.authUrl ?? DEFAULT_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw new ProviderError(`contabo auth failed with HTTP ${res.status}`, { retryable: res.status >= 500 });
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ProviderError("contabo auth returned no access_token");
    this.token = {
      accessToken: body.access_token,
      expiresAtMs: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.accessToken;
  }

  private async throttle(): Promise<void> {
    const elapsed = this.now() - this.lastCallAt;
    if (this.minIntervalMs > 0 && elapsed < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallAt = this.now();
  }

  /**
   * Authenticated JSON request with retries/backoff. `requestId` gives the
   * provider-side idempotency anchor (X-Request-Id).
   */
  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; requestId?: string; query?: Record<string, string> } = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const url = new URL(path, this.creds.apiUrl ?? DEFAULT_API_URL);
      for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
      let res: Response;
      try {
        res = await this.http(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${await this.getToken()}`,
            "x-request-id": options.requestId ?? crypto.randomUUID(),
            "content-type": "application/json",
            accept: "application/json",
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        // Network-level failure: retry with backoff.
        if (attempt >= this.maxRetries) {
          throw new ProviderError(`contabo unreachable after ${attempt + 1} attempts: ${String(error)}`, {
            retryable: true,
          });
        }
        await this.sleep(2 ** attempt * 500);
        attempt += 1;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new ProviderError(`contabo ${method} ${path} failed with HTTP ${res.status}`, {
            retryable: true,
            httpStatus: res.status,
          });
        }
        const retryAfterHeader = res.headers.get("retry-after");
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 500;
        await this.sleep(Number.isFinite(waitMs) ? waitMs : 1000);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderError(`contabo ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, {
          retryable: false,
          httpStatus: res.status,
        });
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }
}

interface ContaboPlanBody {
  data: Array<{
    productId: number;
    displayName?: string;
    cpu?: number;
    ram?: number; // GB
    disk?: number; // GB
    prices?: Array<{ currency?: string; amount?: number; recurringPriceAmount?: number }>;
  }>;
}

interface ContaboLocationBody {
  data: Array<{ locationId?: number; name?: string; friendlyName?: string }>;
}

interface ContaboInstanceBody {
  data: Array<{
    instanceId: number;
    status?: string;
    regionName?: string;
    productId?: string;
    ipAddress?: string;
    ipConfig?: { v4?: { ip?: string }; v6?: { ip?: string } };
    createdDate?: string;
  }>;
}

function mapStatus(status: string | undefined): ProviderInstance["state"] {
  switch (status?.toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "installing":
      return "provisioning";
    case undefined:
      return "pending";
    default:
      return "provisioning";
  }
}

export interface ContaboProviderConfig {
  /** Default OS image used for Mox-provisioned servers. */
  defaultImageId: number;
  /** Non-root sudo user created by cloud-init for the Mox Node agent. */
  defaultUsername?: string;
}

export class ContaboProvider implements ComputeProvider {
  readonly name = "contabo";
  readonly configured = true;
  readonly capabilities: ComputeCapabilities = capabilitiesWith(
    "list_products",
    "list_regions",
    "provision",
    "get_instance",
    "start",
    "stop",
    "reboot",
    "resize",
    "reinstall",
    "cancel",
    "reverse_dns",
    "provider_health",
  );

  private readonly client: ContaboClient;

  constructor(
    creds: ContaboCredentials,
    private readonly config: ContaboProviderConfig,
    options: ContaboOptions = {},
  ) {
    this.client = new ContaboClient(creds, options);
  }

  async listProducts(): Promise<ProviderProduct[]> {
    const body = await this.client.request<ContaboPlanBody>("GET", "/v1/compute/plans");
    return (body.data ?? []).map((plan) => ({
      providerSku: String(plan.productId),
      displayName: plan.displayName ?? String(plan.productId),
      vcpu: plan.cpu ?? 0,
      ramGb: plan.ram ?? 0,
      diskGb: plan.disk ?? 0,
      wholesaleCostMinor: plan.prices?.[0]?.recurringPriceAmount !== undefined
        ? Math.round(plan.prices[0].recurringPriceAmount * 100)
        : undefined,
      wholesaleCurrency: plan.prices?.[0]?.currency ?? "EUR",
    }));
  }

  async listRegions(): Promise<ProviderRegion[]> {
    const body = await this.client.request<ContaboLocationBody>("GET", "/v1/compute/locations");
    return (body.data ?? []).map((loc) => ({
      code: loc.name ?? String(loc.locationId),
      displayName: loc.friendlyName ?? loc.name ?? String(loc.locationId),
    }));
  }

  async provision(input: ProvisionInput): Promise<{ instance: ProviderInstance; operation: ProviderOperation }> {
    const requestId = `mox-${input.idempotencyKey}`;
    const body = {
      imageId: this.config.defaultImageId,
      productId: input.providerSku,
      region: input.regionCode,
      sshKeys: [input.sshPublicKey],
      userData: Buffer.from(input.cloudInitUserData, "utf8").toString("base64"),
      hostname: input.hostname,
      defaultUser: this.config.defaultUsername ?? "moxadmin",
      customizeOnDefault: false,
    };
    const created = await this.client.request<ContaboInstanceBody>("POST", "/v1/compute/instances", {
      body,
      requestId,
    });
    const raw = created.data?.[0];
    if (!raw) throw new ProviderError("contabo provision returned no instance payload", { retryable: true });
    return {
      instance: {
        providerInstanceId: String(raw.instanceId),
        state: mapStatus(raw.status),
        regionCode: raw.regionName ?? input.regionCode,
        providerSku: input.providerSku,
        ipv4: raw.ipConfig?.v4?.ip ?? raw.ipAddress,
        ipv6: raw.ipConfig?.v6?.ip,
        createdAt: raw.createdDate ?? new Date().toISOString(),
      },
      operation: {
        providerOperationId: requestId,
        status: raw.status === "running" ? "succeeded" : "running",
      },
    };
  }

  async getInstance(providerInstanceId: string): Promise<ProviderInstance> {
    const body = await this.client.request<ContaboInstanceBody>(
      "GET",
      `/v1/compute/instances/${encodeURIComponent(providerInstanceId)}`,
    );
    const raw = body.data?.[0];
    if (!raw) throw new ProviderError(`contabo instance ${providerInstanceId} not found`, { httpStatus: 404 });
    return {
      providerInstanceId: String(raw.instanceId),
      state: mapStatus(raw.status),
      regionCode: raw.regionName ?? "",
      providerSku: raw.productId ?? "",
      ipv4: raw.ipConfig?.v4?.ip ?? raw.ipAddress,
      ipv6: raw.ipConfig?.v6?.ip,
      createdAt: raw.createdDate ?? "",
    };
  }

  async start(providerInstanceId: string): Promise<ProviderOperation> {
    return this.simpleAction(`/v1/compute/instances/${encodeURIComponent(providerInstanceId)}/start`);
  }

  async stop(providerInstanceId: string): Promise<ProviderOperation> {
    return this.simpleAction(`/v1/compute/instances/${encodeURIComponent(providerInstanceId)}/stop`);
  }

  async reboot(providerInstanceId: string): Promise<ProviderOperation> {
    return this.simpleAction(`/v1/compute/instances/${encodeURIComponent(providerInstanceId)}/restart`);
  }

  async resize(providerInstanceId: string, targetSku: string): Promise<ProviderOperation> {
    return this.client.request<ProviderOperation>(
      "PATCH",
      `/v1/compute/instances/${encodeURIComponent(providerInstanceId)}`,
      { body: { productId: targetSku }, requestId: `mox-resize-${providerInstanceId}-${targetSku}` },
    );
  }

  async reinstall(providerInstanceId: string, sshPublicKey: string, cloudInitUserData: string): Promise<ProviderOperation> {
    return this.client.request<ProviderOperation>(
      "PUT",
      `/v1/compute/instances/${encodeURIComponent(providerInstanceId)}`,
      {
        body: {
          imageId: this.config.defaultImageId,
          sshKeys: [sshPublicKey],
          userData: Buffer.from(cloudInitUserData, "utf8").toString("base64"),
        },
        requestId: `mox-reinstall-${providerInstanceId}`,
      },
    );
  }

  async cancel(providerInstanceId: string): Promise<ProviderOperation> {
    return this.simpleAction(
      `/v1/compute/instances/${encodeURIComponent(providerInstanceId)}`,
      "DELETE",
      `mox-cancel-${providerInstanceId}`,
    );
  }

  async setReverseDns(providerInstanceId: string, ipv4: string, ptr: string): Promise<void> {
    await this.client.request(
      "PUT",
      `/v1/compute/instances/${encodeURIComponent(providerInstanceId)}/ptr`,
      { body: { ipV4: ipv4, ptrV4: ptr }, requestId: `mox-ptr-${providerInstanceId}` },
    );
  }

  async health(): Promise<import("@mox/contracts").HealthReport> {
    try {
      await this.listRegions();
      return { state: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        state: error instanceof ProviderError && error.httpStatus && error.httpStatus < 500 ? "degraded" : "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private async simpleAction(path: string, method = "POST", requestId?: string): Promise<ProviderOperation> {
    await this.client.request(method, path, requestId ? { requestId } : {});
    return { providerOperationId: requestId ?? crypto.randomUUID(), status: "queued" };
  }
}

/** Builds a configured ContaboProvider or reports exactly what is missing. */
export function contaboProviderFromEnv(env: NodeJS.ProcessEnv): ComputeProvider {
  const clientId = env.CONTABO_CLIENT_ID;
  const clientSecret = env.CONTABO_CLIENT_SECRET;
  const imageId = env.CONTABO_DEFAULT_IMAGE_ID;
  if (!clientId || !clientSecret) {
    return new UnconfiguredComputeProvider(
      "contabo",
      "missing CONTABO_CLIENT_ID / CONTABO_CLIENT_SECRET environment configuration",
    );
  }
  return new ContaboProvider(
    { clientId, clientSecret },
    { defaultImageId: imageId ? Number(imageId) : 0 },
    { minIntervalMs: 1050 },
  );
}

/** Honest placeholder for providers whose credentials are absent. */
export class UnconfiguredComputeProvider implements ComputeProvider {
  readonly name: string;
  readonly configured = false;
  readonly blocker: string;
  readonly commercialStatus = "disabled" as const;
  readonly capabilities = capabilitiesWith();

  private unavailable(): never {
    throw new ProviderError(`compute provider "${this.name}" not configured: ${this.blocker}`);
  }

  constructor(name: string, blocker: string) {
    this.name = name;
    this.blocker = blocker;
  }

  listProducts(): Promise<ProviderProduct[]> {
    return this.unavailable();
  }
  listRegions(): Promise<ProviderRegion[]> {
    return this.unavailable();
  }
  provision(): ReturnType<ComputeProvider["provision"]> {
    return this.unavailable();
  }
  getInstance(): Promise<ProviderInstance> {
    return this.unavailable();
  }
  start(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  stop(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  reboot(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  resize(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  reinstall(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  cancel(): Promise<ProviderOperation> {
    return this.unavailable();
  }
  setReverseDns(): Promise<void> {
    return this.unavailable();
  }
  health(): Promise<import("@mox/contracts").HealthReport> {
    return this.unavailable();
  }
}
