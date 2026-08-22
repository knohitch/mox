/**
 * Scriptable in-memory ComputeProvider for tests and local development.
 * Supports failure injection (timeouts, late success, double-provision
 * detection) so destructive paths can be exercised without real APIs.
 */

import type { HealthReport } from "@mox/contracts";
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

export interface FakeProvisionScript {
  /** Throw after N successful provisions. */
  failAfter?: number;
  failureMessage?: string;
  /** First provision attempt rejects; retry succeeds (late-success test). */
  failFirstAttemptThenSucceed?: boolean;
}

export class FakeComputeProvider implements ComputeProvider {
  readonly name: string;
  readonly configured = true;
  readonly commercialStatus = "active" as const;
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

  private counter = 0;
  readonly instances = new Map<string, ProviderInstance>();
  readonly provisionCalls: ProvisionInput[] = [];
  private script: FakeProvisionScript = {};

  constructor(name = "fake-compute") {
    this.name = name;
  }

  setProvisionScript(script: FakeProvisionScript): void {
    this.script = script;
  }

  async listProducts(): Promise<ProviderProduct[]> {
    return [
      { providerSku: "CX22", displayName: "Shared vCPU 2", vcpu: 2, ramGb: 4, diskGb: 40 },
      { providerSku: "CX32", displayName: "Shared vCPU 4", vcpu: 4, ramGb: 8, diskGb: 80 },
      { providerSku: "CPX41", displayName: "Dedicated 8", vcpu: 8, ramGb: 16, diskGb: 240 },
    ];
  }

  async listRegions(): Promise<ProviderRegion[]> {
    return [
      { code: "fsn1", displayName: "Falkenstein" },
      { code: "ash", displayName: "Ashburn" },
    ];
  }

  async provision(input: ProvisionInput): Promise<{ instance: ProviderInstance; operation: ProviderOperation }> {
    this.provisionCalls.push(input);
    if (this.script.failFirstAttemptThenSucceed && this.counter === 0) {
      this.counter += 1;
      throw new ProviderError("simulated provider timeout", { retryable: true });
    }
    if (this.script.failAfter !== undefined && this.provisionCalls.length > this.script.failAfter) {
      throw new ProviderError(this.script.failureMessage ?? "quota exhausted");
    }
    this.counter += 1;
    const id = `${this.name}-srv-${this.provisionCalls.length}`;
    const instance: ProviderInstance = {
      providerInstanceId: id,
      state: "running",
      regionCode: input.regionCode,
      providerSku: input.providerSku,
      ipv4: `203.0.113.${this.provisionCalls.length % 254 + 1}`,
      createdAt: new Date().toISOString(),
    };
    this.instances.set(id, instance);
    return { instance, operation: { providerOperationId: `${id}-op`, status: "succeeded" } };
  }

  async getInstance(providerInstanceId: string): Promise<ProviderInstance> {
    const instance = this.instances.get(providerInstanceId);
    if (!instance) throw new ProviderError(`unknown instance ${providerInstanceId}`, { httpStatus: 404 });
    return instance;
  }

  async start(providerInstanceId: string): Promise<ProviderOperation> {
    await this.requireInstance(providerInstanceId).then((i) => {
      i.state = "running";
    });
    return { providerOperationId: `${providerInstanceId}-start`, status: "succeeded" };
  }

  async stop(providerInstanceId: string): Promise<ProviderOperation> {
    await this.requireInstance(providerInstanceId).then((i) => {
      i.state = "stopped";
    });
    return { providerOperationId: `${providerInstanceId}-stop`, status: "succeeded" };
  }

  async reboot(providerInstanceId: string): Promise<ProviderOperation> {
    await this.getInstance(providerInstanceId);
    return { providerOperationId: `${providerInstanceId}-reboot`, status: "succeeded" };
  }

  async resize(providerInstanceId: string, targetSku: string): Promise<ProviderOperation> {
    const instance = await this.getInstance(providerInstanceId);
    instance.providerSku = targetSku;
    return { providerOperationId: `${providerInstanceId}-resize`, status: "succeeded" };
  }

  async reinstall(): Promise<ProviderOperation> {
    return { providerOperationId: `reinstall-${++this.counter}`, status: "succeeded" };
  }

  async cancel(providerInstanceId: string): Promise<ProviderOperation> {
    const instance = await this.getInstance(providerInstanceId);
    instance.state = "canceled";
    this.instances.delete(providerInstanceId);
    return { providerOperationId: `${providerInstanceId}-cancel`, status: "succeeded" };
  }

  async setReverseDns(): Promise<void> {}

  async health(): Promise<HealthReport> {
    return { state: "healthy", checkedAt: new Date().toISOString() };
  }

  private async requireInstance(id: string): Promise<ProviderInstance> {
    const instance = this.instances.get(id);
    if (!instance) throw new ProviderError(`unknown instance ${id}`, { httpStatus: 404 });
    return instance;
  }
}
