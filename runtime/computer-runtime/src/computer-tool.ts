import { ToolName, type ComputerAction, type JsonValue, type ToolDefinition } from "@mox/contracts";
import { mintGatewayToken } from "@mox/security";
import { ComputerGateway } from "./gateway.js";
import type { ComputerActionOutcome } from "./provider.js";

/**
 * The `computer` tool: the ONLY tool through which Mox Runtime agent code
 * reaches browser/computer side effects. Mox Runtime uses Mox Computer
 * Gateway for computer/browser side effects.
 *
 * The tool is a thin delegation — it validates the action against the
 * canonical contract and forwards it to the gateway, where entitlement,
 * policy, approval, egress and audit are enforced server-side. It never
 * decides anything itself (Architecture Rule 1: one authority per concern).
 *
 * Approval semantics stay unified: because the GATEWAY owns the human-approval
 * step for computer actions, hosts register this tool with "computer" seeded
 * in the run's approvedTools so the runtime seam does not open a second,
 * competing approval flow for the same action.
 */

export interface ComputerToolInput {
  action: ComputerAction;
}

export interface ComputerToolOptions {
  gateway: ComputerGateway;
  /**
   * Mints a short-lived gateway token BOUND TO THE GIVEN SESSION (the gateway
   * rejects tokens whose claims do not match the addressed session). Called
   * with "bootstrap" for the initial open, then with the assigned session id.
   */
  tokenFor(sessionId: string): string;
  /** Pre-opened session id; when absent the tool opens one on first use. */
  sessionId?: string;
  /** Org/agent scope used to open + bind the session (server-asserted). */
  orgId: string;
  agentId: string;
  /** Server hook resolving page facts (ARIA snapshot owner = gateway side). */
  resolvePageFacts?: () =>
    | { url: string; host: string; element?: { ref: string; role: string; name: string } }
    | undefined;
}

export interface ComputerToolBinding {
  definition: ToolDefinition;
  execute(input: unknown): Promise<ComputerActionOutcome>;
  /** Session id in use (assigned after first successful open). */
  readonly sessionId: () => string | undefined;
}

const COMPUTER_INPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    action: {
      oneOf: [
        { type: "object", properties: { kind: { const: "screenshot" } }, required: ["kind"] },
        {
          type: "object",
          properties: {
            kind: { const: "click" },
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            button: { enum: ["left", "right", "middle"] },
          },
          required: ["kind", "x", "y"],
        },
        { type: "object", properties: { kind: { const: "type" }, text: { type: "string" } }, required: ["kind", "text"] },
        { type: "object", properties: { kind: { const: "key" }, key: { type: "string", minLength: 1 } }, required: ["kind", "key"] },
        {
          type: "object",
          properties: { kind: { const: "scroll" }, direction: { enum: ["up", "down"] }, amount: { type: "integer", minimum: 1 } },
          required: ["kind", "direction", "amount"],
        },
        { type: "object", properties: { kind: { const: "navigate" }, url: { type: "string", minLength: 1 } }, required: ["kind", "url"] },
        { type: "object", properties: { kind: { const: "execute" }, command: { type: "string", minLength: 1 } }, required: ["kind", "command"] },
        { type: "object", properties: { kind: { const: "wait" }, ms: { type: "integer", minimum: 1 } }, required: ["kind", "ms"] },
      ],
    },
  },
  required: ["action"],
};

export function createComputerTool(opts: ComputerToolOptions): ComputerToolBinding {
  let boundSessionId = opts.sessionId;

  const definition: ToolDefinition = {
    name: ToolName.parse("computer"),
    displayName: "Computer",
    description:
      "Drive the agent's isolated computer/browser (navigate, click, type, key, scroll, screenshot, wait). " +
      "All authorization is enforced by the Mox Computer Gateway.",
    inputSchema: COMPUTER_INPUT_SCHEMA,
    // Danger is fully governed by the authoritative gateway flow; the runtime
    // seam must not open a parallel approval path (see file header).
    dangerLevel: "read-only",
    requiresApproval: false,
  };

  async function ensureSession(): Promise<string> {
    if (boundSessionId !== undefined) return boundSessionId;
    // Session ids are assigned by the gateway; the bootstrap token only
    // proves org/agent scope. Afterwards every token is session-bound.
    const opened = await opts.gateway.openSession(opts.tokenFor("bootstrap"), {});
    boundSessionId = opened.sessionId;
    return boundSessionId;
  }

  return {
    definition,
    sessionId: () => boundSessionId,
    async execute(rawInput: unknown): Promise<ComputerActionOutcome> {
      const input = rawInput as Partial<ComputerToolInput> | undefined;
      if (!input || typeof input.action !== "object" || input.action === null) {
        throw new Error("computer tool requires { action }");
      }
      const action = input.action as ComputerAction;
      const sessionId = await ensureSession();
      const pageFacts = opts.resolvePageFacts?.();
      const { outcome } = await opts.gateway.executeAction(
        opts.tokenFor(sessionId),
        sessionId,
        action,
        pageFacts,
      );
      return outcome;
    },
  };
}

export { mintGatewayToken };
