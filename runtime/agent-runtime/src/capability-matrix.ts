export type RuntimeCapabilityStatus = "implemented" | "partial" | "missing";

export interface RuntimeCapabilityRow {
  capability: string;
  implemented: RuntimeCapabilityStatus;
  productionPath: string;
  tests: string[];
}

/**
 * Mox Runtime capability audit.
 *
 * This matrix is intentionally code, not a prose-only checklist: tests assert
 * that every requested core area is documented and that production has no
 * silent/missing authority path. "partial" means the production path exists
 * and fails honestly where a host adapter is unavailable.
 */
export const MOX_RUNTIME_CAPABILITY_MATRIX: readonly RuntimeCapabilityRow[] = [
  {
    capability: "model loop",
    implemented: "implemented",
    productionPath: "Mox Runtime protocol run.start -> Mox Model Gateway dispatch",
    tests: ["runtime-client protocol", "agent-runtime production mode", "model-gateway integration"],
  },
  {
    capability: "tool registry",
    implemented: "implemented",
    productionPath: "per-run ToolRegistry populated from AgentDefinition and Integration Gateway grants",
    tests: ["agent-runtime tool policy enforcement"],
  },
  {
    capability: "session/event integration",
    implemented: "implemented",
    productionPath: "RuntimeClient runtime.event -> Mox event store append/replay",
    tests: ["agent-runtime restart/resume", "runtime-client stream events"],
  },
  {
    capability: "filesystem/workspace",
    implemented: "implemented",
    productionPath: "Mox Computer Gateway workspace/file tools with org/thread scope",
    tests: ["terminal/files isolation", "tool policy enforcement"],
  },
  {
    capability: "shell",
    implemented: "implemented",
    productionPath: "Mox Computer Gateway shell capability, entitlement and policy checked",
    tests: ["terminal/files isolation", "tool policy enforcement"],
  },
  {
    capability: "persistent terminal",
    implemented: "implemented",
    productionPath: "Mox Computer persistent session provider through gateway-owned session ids",
    tests: ["terminal/files isolation", "crash recovery"],
  },
  {
    capability: "subprocess",
    implemented: "implemented",
    productionPath: "sandboxed command execution via Mox Computer Gateway shell/subprocess effect class",
    tests: ["tool policy enforcement"],
  },
  {
    capability: "sandbox/code runtime",
    implemented: "implemented",
    productionPath: "Mox Computer sandbox target selected by deployment and entitlement",
    tests: ["terminal/files isolation", "credential scoping"],
  },
  {
    capability: "LSP",
    implemented: "partial",
    productionPath: "developer-mode tool adapter when the runtime image exposes an LSP server; otherwise explicit unavailable result",
    tests: ["developer capability matrix"],
  },
  {
    capability: "skills",
    implemented: "implemented",
    productionPath: "AgentDefinition.skills resolved into runtime context by Mox Runtime config provider",
    tests: ["agent definition validation"],
  },
  {
    capability: "hooks",
    implemented: "implemented",
    productionPath: "runtime hooks execute as registered tools/workflow steps through policy",
    tests: ["workflow/schedule"],
  },
  {
    capability: "context management",
    implemented: "implemented",
    productionPath: "thread/room event replay plus scoped memory context from Mox stores",
    tests: ["multi-agent room", "restart/resume"],
  },
  {
    capability: "compaction",
    implemented: "implemented",
    productionPath: "Mox Runtime context manager emits artifact/event summaries, persisted in event store",
    tests: ["large-result spill/artifacts"],
  },
  {
    capability: "guards",
    implemented: "implemented",
    productionPath: "Mox Policy fail-closed decisions before every tool/computer/integration action",
    tests: ["tool policy enforcement"],
  },
  {
    capability: "subagents",
    implemented: "implemented",
    productionPath: "AgentDefinition.subagents delegated by Mox Runtime with quotas and scoped context",
    tests: ["subagent quotas", "multi-agent room"],
  },
  {
    capability: "multi-agent coordination",
    implemented: "implemented",
    productionPath: "Agent Rooms shared objectives and event visibility through Mox event store",
    tests: ["multi-agent room"],
  },
  {
    capability: "jobs",
    implemented: "implemented",
    productionPath: "Mox Runtime job events and durable notification/workflow job stores",
    tests: ["workflow/schedule", "crash recovery"],
  },
  {
    capability: "workflows",
    implemented: "implemented",
    productionPath: "AgentDefinition.workflows launched as runtime jobs with event-store checkpoints",
    tests: ["workflow/schedule"],
  },
  {
    capability: "schedules",
    implemented: "implemented",
    productionPath: "AgentDefinition.schedules enqueue Mox Runtime workflow/job starts",
    tests: ["workflow/schedule"],
  },
  {
    capability: "goals",
    implemented: "implemented",
    productionPath: "goal state stored in runtime context/events, never local-only runtime memory",
    tests: ["multi-agent room"],
  },
  {
    capability: "plans",
    implemented: "implemented",
    productionPath: "plan state stored as scoped runtime artifacts/events",
    tests: ["multi-agent room"],
  },
  {
    capability: "todos",
    implemented: "implemented",
    productionPath: "todo state stored as scoped runtime artifacts/events",
    tests: ["multi-agent room"],
  },
  {
    capability: "human feedback",
    implemented: "implemented",
    productionPath: "canonical ApprovalRequest and message feedback through control plane/event store",
    tests: ["approvals", "human feedback"],
  },
  {
    capability: "attachments",
    implemented: "implemented",
    productionPath: "attachments_meta and scoped storage keys passed as runtime context refs",
    tests: ["large-result spill/artifacts"],
  },
  {
    capability: "large-result spill/artifacts",
    implemented: "implemented",
    productionPath: "artifact.produced events with storage refs; large payloads stay out of event bodies",
    tests: ["large-result spill/artifacts"],
  },
  {
    capability: "storage",
    implemented: "implemented",
    productionPath: "Mox event store, memory store, attachment metadata and configured object storage refs",
    tests: ["restart/resume", "crash recovery"],
  },
  {
    capability: "web search/fetch",
    implemented: "implemented",
    productionPath: "Integration Gateway or Mox Computer browser tools, never direct model/runtime bypass",
    tests: ["tool policy enforcement"],
  },
  {
    capability: "SDK/runtime protocol",
    implemented: "implemented",
    productionPath: "@mox/runtime-client JSON-RPC protocol over explicit runtime transport",
    tests: ["runtime-client protocol"],
  },
  {
    capability: "crash/resume",
    implemented: "implemented",
    productionPath: "runtime resumeToken checkpoints plus bounded AgentRuntime restartAfterCrash",
    tests: ["restart/resume", "crash recovery"],
  },
  {
    capability: "cancel",
    implemented: "implemented",
    productionPath: "run.cancel through @mox/runtime-client and supervised shutdown",
    tests: ["cancel", "restart/resume"],
  },
  {
    capability: "approvals",
    implemented: "implemented",
    productionPath: "Mox Policy and gateway-owned ApprovalRequest flow",
    tests: ["approvals", "tool policy enforcement"],
  },
];

export const REQUIRED_RUNTIME_CAPABILITIES = MOX_RUNTIME_CAPABILITY_MATRIX.map((row) => row.capability);

export function capabilityMatrixMarkdown(): string {
  const header = "| Capability | Implemented | Production path | Tests |\n|---|---|---|---|";
  const rows = MOX_RUNTIME_CAPABILITY_MATRIX.map(
    (row) => `| ${row.capability} | ${row.implemented} | ${row.productionPath} | ${row.tests.join(", ")} |`,
  );
  return [header, ...rows].join("\n");
}

export function assertRuntimeCapabilityMatrixClosed(): void {
  const missing = MOX_RUNTIME_CAPABILITY_MATRIX.filter((row) => row.implemented === "missing");
  if (missing.length > 0) {
    throw new Error(`Mox Runtime capability matrix has missing core rows: ${missing.map((row) => row.capability).join(", ")}`);
  }
  for (const row of MOX_RUNTIME_CAPABILITY_MATRIX) {
    if (!row.productionPath || row.tests.length === 0) {
      throw new Error(`Mox Runtime capability row is not closed: ${row.capability}`);
    }
  }
}
