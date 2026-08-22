import { AgentEvent, type AgentId } from "@mox/contracts";
import { createEnvelope, type Envelope } from "@mox/events";

/**
 * DSH (DeepSeek Harness) runtime/session event → Mox AgentEvent.
 *
 * Mirrors the minimal session-event shapes DSH emits during a turn. The
 * mapping wraps each canonical AgentEvent in the @mox/events envelope so
 * DSH-sourced streams join the same causation chain as native Mox events.
 * Structural mirror only — no import from deepseek-harness-master.
 */

export type DshSessionEvent =
  | { kind: "turn-start"; turnId: string; at: string }
  | { kind: "assistant-delta"; turnId: string; messageId: string; delta: string; at: string }
  | { kind: "assistant-message"; turnId: string; messageId: string; text: string; at: string }
  | { kind: "tool-call"; turnId: string; tool: string; input: unknown; at: string }
  | { kind: "tool-result"; turnId: string; tool: string; output: unknown; ok: boolean; at: string }
  | { kind: "error"; turnId: string; message: string; fatal: boolean; at: string }
  | { kind: "turn-end"; turnId: string; at: string };

export interface DshEventContext {
  agentId: AgentId;
  correlationId: string;
}

/** Map one DSH session event to a canonical AgentEvent. */
export function dshEventToAgentEvent(dsh: DshSessionEvent, ctx: DshEventContext): AgentEvent {
  const base = { eventId: crypto.randomUUID(), agentId: ctx.agentId, turnId: dsh.turnId, at: dsh.at };
  switch (dsh.kind) {
    case "turn-start":
      return AgentEvent.parse({ ...base, type: "turn.started" });
    case "assistant-delta":
      return AgentEvent.parse({ ...base, type: "message.delta", messageId: dsh.messageId, delta: dsh.delta });
    case "assistant-message":
      return AgentEvent.parse({ ...base, type: "message.completed", messageId: dsh.messageId, text: dsh.text });
    case "tool-call":
      return AgentEvent.parse({ ...base, type: "tool.requested", toolName: dsh.tool, input: dsh.input });
    case "tool-result":
      return AgentEvent.parse({
        ...base,
        type: "tool.completed",
        toolName: dsh.tool,
        output: dsh.output,
        ok: dsh.ok,
      });
    case "error":
      return AgentEvent.parse({ ...base, type: "error", error: dsh.message, fatal: dsh.fatal });
    case "turn-end":
      return AgentEvent.parse({ ...base, type: "turn.completed" });
  }
}

/** Map and wrap in the canonical event envelope. */
export function dshEventToEnvelope(dsh: DshSessionEvent, ctx: DshEventContext): Envelope<AgentEvent> {
  const event = dshEventToAgentEvent(dsh, ctx);
  return createEnvelope({
    type: `agent.${event.type}`,
    version: 1,
    scope: {},
    correlationId: ctx.correlationId,
    at: dsh.at,
    payload: event,
  });
}