import type { CapabilitiesResult, RuntimeClient } from "@mox/runtime-client";
import { REQUIRED_RUNTIME_CAPABILITIES, assertRuntimeCapabilityMatrixClosed } from "./capability-matrix.js";

export type MoxRuntimeMode = "full" | "disabled" | "reference-dev";

export class MoxRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoxRuntimeUnavailableError";
  }
}

export interface RuntimeModePolicy {
  nodeEnv: "production" | "development" | "test";
  mode: MoxRuntimeMode;
  runtimeCommand?: string;
}

/**
 * Fail-closed production gate. Production requires an explicit full Mox
 * Runtime transport; reference-dev is allowed only for tests/explicit local
 * development and never by fallback.
 */
export function assertMoxRuntimeMode(policy: RuntimeModePolicy): void {
  assertRuntimeCapabilityMatrixClosed();
  if (policy.nodeEnv === "production") {
    if (policy.mode !== "full") {
      throw new MoxRuntimeUnavailableError("production requires MOX_RUNTIME_MODE=full; reference or disabled runtime is not allowed");
    }
    if (!policy.runtimeCommand?.trim()) {
      throw new MoxRuntimeUnavailableError("production Mox Runtime requires MOX_RUNTIME_COMMAND");
    }
  }
  if (policy.mode === "reference-dev" && policy.nodeEnv === "production") {
    throw new MoxRuntimeUnavailableError("reference runtime is test/development only");
  }
}

export function rejectReferenceRuntimeCapabilities(capabilities: CapabilitiesResult): void {
  const runtimeName = capabilities.runtime.toLowerCase();
  if (runtimeName.includes("reference") || runtimeName.includes("demo") || runtimeName.includes("test")) {
    throw new MoxRuntimeUnavailableError(`production cannot use non-production runtime: ${capabilities.runtime}`);
  }
}

export async function verifyFullMoxRuntime(client: RuntimeClient, nodeEnv: RuntimeModePolicy["nodeEnv"]): Promise<CapabilitiesResult> {
  const capabilities = await client.capabilities();
  if (nodeEnv === "production") rejectReferenceRuntimeCapabilities(capabilities);
  const exposed = new Set(capabilities.capabilities);
  const missing = REQUIRED_RUNTIME_CAPABILITIES.filter((capability) => !exposed.has(capability));
  if (missing.length > 0) {
    throw new MoxRuntimeUnavailableError(`Mox Runtime is missing required capabilities: ${missing.join(", ")}`);
  }
  return capabilities;
}
