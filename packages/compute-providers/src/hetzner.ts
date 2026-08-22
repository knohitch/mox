/**
 * Hetzner Cloud adapter (Prompt 09).
 *
 * Technically complete against https://api.hetzner.cloud/v1, but production
 * enablement is commercially gated: `commercialStatus` defaults to "verify"
 * and the orchestrator refuses to select it until an admin sets it to
 * "approved". No automatic production selection before commercial approval.
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

export interface HetznerCredentials {
  apiToken: string;
  apiUrl?: string;
}

export interface HetznerOptions {
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API_URL = "https://api.hetzner.cloud/v1";

export class HetznerClient {
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    private readonly creds: HetznerCredentials,
    options: HetznerOptions = {},
  ) {
    this.http = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 4;
  }

  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const url = `${this.creds.apiUrl ?? DEFAULT_API_URL}${path}`;
      let res: Response;
      try {
        res = await this.http(url, {
          method,
          headers: {
            authorization: `Bearer ${this.creds.apiToken}`,
            "content-type": "application/json",
            accept: "application/json",
            ...(options.idempotencyKey ? { "x-mox-idempotency": options.idempotencyKey } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new ProviderError(`hetzner unreachable after ${attempt + 1} attempts: ${String(error)}`, {
            retryable: true,
          });
        }
        await this.sleep(2 ** attempt * 500);
        attempt += 1;
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new ProviderError(`hetzner ${method} ${path} failed with HTTP ${res.status}`, {
            retryable: true,
            httpStatus: res.status,
          });
        }
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 2 ** attempt * 500;
        await this.sleep(Number.isFinite(waitMs) ? waitMs : 1000);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderError(`hetzner ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, {
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

interface HetznerServerTypeBody {
  server_types: Array<{
    id: number;
    name: string;
    cores: number;
    memory: number; // GB
    disk: number; // GB
    prices?: Array<{ price_monthly?: { net?: string; gross?: string }; currency?: string }>;
  }>;
}

interface HetznerLocationBody {
  locations: Array<{ id: number; name: string; city?: string; country?: string }>;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  server_type?: { id?: number; name?: string };
  datacenter?: { location?: { name?: string } };
  public_net?: { ipv4?: { ip?: string }; ipv6?: { ip?: string } };
  created?: string;
}

interface HetznerAction {
  id: number;
  status: "queued" | "running" | "success" | "error";
  error?: { code?: string; message?: string };
}

function mapStatus(status: string | undefined): ProviderInstance["state"] {
  switch (status) {
    case "running":
      return "running";
    case "off":
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "initializing":
      return "provisioning";
    default:
      return "provisioning";
  }
}

function mapAction(action: HetznerAction | undefined, fallbackId: string): ProviderOperation {
  if (!action) return { providerOperationId: fallbackId, status: "queued" };
  return {
    providerOperationId: String(action.id),
    status:
      action.status === "success" ? "succeeded" : action.status === "error" ? "failed" : action.status,
    errorCode: action.error?.code,
    message: action.error?.message,
  };
}

export type CommercialGate = "verify" | "approved";

export class HetznerProvider implements ComputeProvider {
  readonly name = "hetzner";
  readonly configured = true;

  /**
   * Commercial gate. Only "approved" allows the orchestrator to route
   * customer workloads here. Defaults to "verify" (never auto-enabled).
   */
  readonly commercialStatus: CommercialGate;

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
    "snapshots",
    "reverse_dns",
    "provider_health",
  );

  private readonly client: HetznerClient;

  constructor(
    creds: HetznerCredentials,
    options: HetznerOptions & { commercialStatus?: CommercialGate } = {},
  ) {
    this.client = new HetznerClient(creds, options);
    this.commercialStatus = options.commercialStatus ?? "verify";
  }

  async listProducts(): Promise<ProviderProduct[]> {
    const body = await this.client.request<HetznerServerTypeBody>("GET", "/server_types");
    return body.server_types.map((st) => ({
      providerSku: st.name,
      displayName: st.name,
      vcpu: st.cores,
      ramGb: st.memory,
      diskGb: st.disk,
      wholesaleCostMinor: st.prices?.[0]?.price_monthly?.net !== undefined
        ? Math.round(Number(st.prices[0].price_monthly.net) * 100)
        : undefined,
      wholesaleCurrency: st.prices?.[0]?.currency ?? "EUR",
    }));
  }

  async listRegions(): Promise<ProviderRegion[]> {
    const body = await this.client.request<HetznerLocationBody>("GET", "/locations");
    return body.locations.map((loc) => ({
      code: loc.name,
      displayName: [loc.city, loc.country].filter(Boolean).join(", ") || loc.name,
    }));
  }

  async provision(input: ProvisionInput): Promise<{ instance: ProviderInstance; operation: ProviderOperation }> {
    const created = await this.client.request<{ server: HetznerServer; action?: HetznerAction }>(
      "POST",
      "/servers",
      {
        idempotencyKey: input.idempotencyKey,
        body: {
          name: input.hostname,
          server_type: input.providerSku,
          location: input.regionCode,
          ssh_keys: [], // key names must be pre-registered; Mox injects via user_data
          user_data: input.cloudInitUserData,
          start_after_create: true,
          public_net: { enable_ipv4: true, enable_ipv6: true },
        },
      },
    );
    const server = created.server;
    if (!server) throw new ProviderError("hetzner provision returned no server payload", { retryable: true });
    return {
      instance: {
        providerInstanceId: String(server.id),
        state: mapStatus(server.status),
        regionCode: server.datacenter?.location?.name ?? input.regionCode,
        providerSku: server.server_type?.name ?? input.providerSku,
        ipv4: server.public_net?.ipv4?.ip,
        ipv6: server.public_net?.ipv6?.ip,
        createdAt: server.created ?? new Date().toISOString(),
      },
      operation: mapAction(created.action, input.idempotencyKey),
    };
  }

  async getInstance(providerInstanceId: string): Promise<ProviderInstance> {
    const body = await this.client.request<{ server: HetznerServer }>(
      "GET",
      `/servers/${encodeURIComponent(providerInstanceId)}`,
    );
    const s = body.server;
    if (!s) throw new ProviderError(`hetzner server ${providerInstanceId} not found`, { httpStatus: 404 });
    return {
      providerInstanceId: String(s.id),
      state: mapStatus(s.status),
      regionCode: s.datacenter?.location?.name ?? "",
      providerSku: s.server_type?.name ?? "",
      ipv4: s.public_net?.ipv4?.ip,
      ipv6: s.public_net?.ipv6?.ip,
      createdAt: s.created ?? "",
    };
  }

  async start(providerInstanceId: string): Promise<ProviderOperation> {
    const body = await this.client.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/poweron`,
    );
    return mapAction(body.action, `start-${providerInstanceId}`);
  }

  async stop(providerInstanceId: string): Promise<ProviderOperation> {
    const body = await this.client.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/poweroff`,
    );
    return mapAction(body.action, `stop-${providerInstanceId}`);
  }

  async reboot(providerInstanceId: string): Promise<ProviderOperation> {
    const body = await this.client.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/reboot`,
    );
    return mapAction(body.action, `reboot-${providerInstanceId}`);
  }

  async resize(providerInstanceId: string, targetSku: string): Promise<ProviderOperation> {
    const body = await this.client.request<{ action: HetznerAction }>(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/change_type`,
      { body: { server_type: targetSku, upgrade_disk: true } },
    );
    return mapAction(body.action, `resize-${providerInstanceId}-${targetSku}`);
  }

  async reinstall(providerInstanceId: string, _sshPublicKey: string, cloudInitUserData: string): Promise<ProviderOperation> {
    const body = await this.client.request<{ action: HetznerAction; root_password?: string }>(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/rebuild`,
      { body: { user_data: cloudInitUserData } },
    );
    return mapAction(body.action, `reinstall-${providerInstanceId}`);
  }

  async cancel(providerInstanceId: string): Promise<ProviderOperation> {
    // Hetzner delete is synchronous 2xx; synthesize a succeeded operation.
    await this.client.request(
      "DELETE",
      `/servers/${encodeURIComponent(providerInstanceId)}`,
    );
    return { providerOperationId: `cancel-${providerInstanceId}`, status: "succeeded" };
  }

  async setReverseDns(providerInstanceId: string, ipv4: string, ptr: string): Promise<void> {
    await this.client.request(
      "POST",
      `/servers/${encodeURIComponent(providerInstanceId)}/actions/change_dns_ptr`,
      { body: { ip: ipv4, dns_ptr: ptr } },
    );
  }

  async health(): Promise<import("@mox/contracts").HealthReport> {
    try {
      await this.listRegions();
      return { state: "healthy", checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

/**
 * Env-driven factory. Without HETZNER_API_TOKEN this returns an honest
 * unconfigured provider; even with credentials the commercial gate stays
 * on "verify" until an admin approves production selection.
 */
export function hetznerProviderFromEnv(env: NodeJS.ProcessEnv): ComputeProvider {
  const token = env.HETZNER_API_TOKEN;
  if (!token) {
    return new UnconfiguredHetzner("missing HETZNER_API_TOKEN environment configuration");
  }
  const approved = env.HETZNER_COMMERCIAL_STATUS === "approved";
  return new HetznerProvider({ apiToken: token }, { commercialStatus: approved ? "approved" : "verify" });
}

export class UnconfiguredHetzner implements ComputeProvider {
  readonly name = "hetzner";
  readonly configured = false;
  readonly blocker: string;
  readonly commercialStatus = "disabled" as const;
  readonly capabilities = capabilitiesWith();

  constructor(blocker: string) {
    this.blocker = blocker;
  }

  private unavailable(): never {
    throw new ProviderError(`compute provider "${this.name}" not configured: ${this.blocker}`);
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
