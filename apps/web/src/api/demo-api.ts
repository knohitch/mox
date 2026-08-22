import {
  AgentId,
  type AgentDefinition,
  type AgentDeployment,
  type AgentEvent,
  type AgentRoom,
  ApprovalId,
  type ApprovalRequest,
  EventId,
  MessageId,
  ModelId,
  OrgId,
  ProviderId,
  RoomId,
  ToolName,
  TurnId,
  UserId,
} from "@mox/contracts";

/** Web-Crypto UUID: works in the browser bundle and Node >=19. */
const randomUUID = (): string => crypto.randomUUID();
import type {
  AgentSummary,
  ChatMessage,
  CliEngineRow,
  ComputerSnapshot,
  Entitlements,
  InvoiceRow,
  ModelOption,
  MoxApi,
  SendRunHandle,
  ServerSummary,
  UsageRow,
} from "./types.js";

/**
 * DEMO DATA implementation of the MoxApi seam (Prompt 05).
 *
 * This is NOT a mock success story: it is an honest in-browser stand-in for
 * the control plane, clearly labeled in the UI ("demo data"). Every domain
 * behavior the views rely on — streaming turns, tool events, approval gates,
 * entitlement gating, computer takeover state — is exercised for real against
 * canonical contracts so swapping in the HTTP/SSE client later is mechanical.
 */

const now = (): string => new Date().toISOString();

function definition(
  input: Partial<AgentDefinition> & Pick<AgentDefinition, "agentId" | "slug" | "identity">,
): AgentDefinition {
  return {
    schemaVersion: 1,
    agentId: input.agentId,
    slug: input.slug,
    identity: input.identity,
    orgId: OrgId.parse("org_demo"),
    instructions: input.instructions ?? { text: "You are a helpful Mox agent." },
    model:
      input.model ??
      {
        providerId: ProviderId.parse("p_openai"),
        modelId: ModelId.parse("gpt-4.1"),
      },
    tools: input.tools ?? { toolNames: [ToolName.parse("computer"), ToolName.parse("files")], integrations: [] },
    skills: input.skills ?? [],
    knowledge: input.knowledge ?? [],
    computer: input.computer ?? { enabled: true, allowBrowser: true, sandbox: "container" },
    voice: input.voice ?? { enabled: false },
    channels: input.channels ?? [],
    deployment: input.deployment ?? { kind: "mox-cloud", region: "eu-central" },
    permissions: input.permissions ?? { toolPolicy: "default", requireApprovalFor: ["computer"] },
    memory: input.memory ?? { enabled: true, scope: "agent" },
    schedules: input.schedules ?? [],
    workflows: input.workflows ?? [],
    subagents: input.subagents ?? [],
    authoring: input.authoring ?? { mode: "simple" },
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? now(),
    updatedAt: input.updatedAt ?? now(),
  };
}

function seedAgents(): AgentSummary[] {
  const mk = (
    agentId: string,
    slug: string,
    displayName: string,
    title: string,
    role: string,
    extra: Partial<AgentDefinition> = {},
    deploymentState: AgentDeployment["state"] = "running",
    runtimeStatus = "ready",
  ): AgentSummary => ({
    definition: definition({
      agentId: AgentId.parse(agentId),
      slug,
      identity: { displayName, title, role },
      ...extra,
    }),
    deploymentState,
    runtimeStatus,
    modelBadge: "gpt-4.1",
  });

  return [
    mk("a_browse", "browse-bot", "Browsy", "Web Researcher", "Finds and verifies information online", {
      computer: { enabled: true, allowBrowser: true, sandbox: "container" },
    }),
    mk("a_code", "code-monkey", "Patch", "Software Engineer", "Writes and reviews code changes"),
    mk("a_ops", "ops-sentinel", "Sentinel", "Ops Monitor", "Watches servers and alerts", {}, "degraded"),
    mk("a_writer", "doc-smith", "Quill", "Technical Writer", "Turns activity into documentation"),
    mk("a_bench", "bench-agent", "Bench", "Unassigned Intern", "Waiting for a first deployment", {}, "stopped"),
  ];
}

interface StoreShape {
  agents: Map<string, AgentSummary>;
  threads: Map<string, Array<{ threadId: string; title?: string; agentId: string }>>;
  messages: Map<string, ChatMessage[]>;
  events: Map<string, AgentEvent[]>;
  approvals: Map<string, ApprovalRequest>;
  rooms: Map<string, AgentRoom>;
  computerSessions: Map<string, ComputerSnapshot>;
}

export class DemoMoxApi implements MoxApi {
  private readonly s: StoreShape;

  constructor() {
    const agents = seedAgents();
    this.s = { agents: new Map(), threads: new Map(), messages: new Map(), events: new Map(), approvals: new Map(), rooms: new Map(), computerSessions: new Map() };
    for (const a of agents) this.s.agents.set(a.definition.agentId, a);

    // Primary thread per agent.
    for (const id of ["a_browse", "a_code", "a_writer"]) {
      const threadId = `t_${id}`;
      this.s.threads.set(id, [{ threadId, title: "Direct chat", agentId: id }]);
      this.s.messages.set(threadId, [
        {
          messageId: randomUUID(),
          threadId,
          authorId: "system",
          role: "system",
          text: "Thread created.",
          at: now(),
        },
      ]);
      this.s.events.set(threadId, []);
    }

    this.s.rooms.set("r_launch", {
      roomId: RoomId.parse("r_launch"),
      orgId: OrgId.parse("org_demo"),
      title: "Launch war room",
      memberAgentIds: ["a_browse", "a_code", "a_writer"].map((id) => AgentId.parse(id)),
      memberUserIds: [UserId.parse("u_founder")],
      createdAt: now(),
    });
    this.s.threads.set("room:r_launch", [{ threadId: "room:r_launch", title: "Launch war room", agentId: "*" }]);
    this.s.messages.set("room:r_launch", []);
    this.s.events.set("room:r_launch", []);

    this.s.computerSessions.set(
      "a_browse",
      {
        sessionId: "cs_browse_1",
        state: "active",
        humanControl: false,
        url: "https://example.com/quarterly-report",
        frameLabel: "reference frame · isolated Chromium (demo runtime)",
        capturedAt: now(),
      },
    );
  }

  // ---- Roster ----

  async listAgents(): Promise<AgentSummary[]> {
    return Array.from(this.s.agents.values());
  }

  async getAgent(agentId: string): Promise<AgentSummary | undefined> {
    return this.s.agents.get(agentId);
  }

  async updateModel(agentId: string, modelId: string): Promise<void> {
    const a = this.requireAgent(agentId);
    a.modelBadge = modelId;
    a.definition = {
      ...a.definition,
      model: {
        providerId: ProviderId.parse("p_openai"),
        modelId: ModelId.parse(modelId),
      },
      updatedAt: now(),
    };
  }

  // ---- Threads & chat ----

  async listThreads(subjectId: string): Promise<Array<{ threadId: string; title?: string }>> {
    return this.s.threads.get(subjectId) ?? [];
  }

  async getMessages(threadId: string): Promise<ChatMessage[]> {
    return [...(this.s.messages.get(threadId) ?? [])];
  }

  async send(agentId: string, threadId: string, text: string, onEvent: (e: AgentEvent) => void): Promise<SendRunHandle> {
    this.ensureThread(agentId, threadId);
    const userMsg: ChatMessage = {
      messageId: randomUUID(),
      threadId,
      authorId: "u_you",
      role: "user",
      text,
      at: now(),
    };
    this.pushMessage(threadId, userMsg);

    let cancelled = false;
    const runId = randomUUID();
    const turnId = randomUUID();
    const agentName = this.requireAgent(agentId).definition.identity.displayName;
    const requiresApproval = this.requiresComputerApproval(agentId) && /browse|open|visit|go to|http/i.test(text);

    const done = this.simulateRun({
      runId,
      turnId,
      agentId,
      agentName,
      threadId,
      text,
      requiresApproval,
      isCancelled: () => cancelled,
      onEvent,
    });

    return {
      runId,
      done,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  // ---- Approvals ----

  async openApprovals(): Promise<ApprovalRequest[]> {
    return Array.from(this.s.approvals.values()).filter((a) => a.state === "open");
  }

  async resolveApproval(approvalId: string, outcome: "approved" | "denied"): Promise<void> {
    const req = this.s.approvals.get(approvalId);
    if (!req || req.state !== "open") throw new Error(`approval not open: ${approvalId}`);
    req.state = outcome;
    req.resolvedAt = now();
  }

  // ---- Events ----

  async getEvents(subjectId: string): Promise<AgentEvent[]> {
    return [...(this.s.events.get(subjectId) ?? [])];
  }

  // ---- Rooms ----

  async listRooms(): Promise<AgentRoom[]> {
    return Array.from(this.s.rooms.values());
  }

  async createRoom(input: { title: string; memberAgentIds: string[] }): Promise<AgentRoom> {
    const room: AgentRoom = {
      roomId: RoomId.parse(`r_${randomUUID().slice(0, 8)}`),
      orgId: OrgId.parse("org_demo"),
      title: input.title,
      memberAgentIds: input.memberAgentIds.map((id) => AgentId.parse(id)),
      memberUserIds: [UserId.parse("u_you")],
      createdAt: now(),
    };
    this.s.rooms.set(room.roomId, room);
    this.s.threads.set(`room:${room.roomId}`, [{ threadId: `room:${room.roomId}`, title: room.title, agentId: "*" }]);
    this.s.messages.set(`room:${room.roomId}`, []);
    this.s.events.set(`room:${room.roomId}`, []);
    return room;
  }

  // ---- Infrastructure ----

  async listServers(): Promise<ServerSummary[]> {
    return [
      { serverId: "srv_1", displayName: "mox-cloud · eu-central-1", kind: "mox-cloud", region: "eu-central", state: "running", agentsRunning: 3, cpuPct: 41, memPct: 58 },
      { serverId: "srv_2", displayName: "customer-vps · contabo #8841", kind: "customer-vps", region: "us-east", state: "running", agentsRunning: 1, cpuPct: 12, memPct: 34 },
      { serverId: "srv_3", displayName: "customer-vps · hetzner #2210", kind: "customer-vps", region: "eu-west", state: "degraded", agentsRunning: 0, cpuPct: 96, memPct: 91 },
    ];
  }

  async listDeployments(): Promise<AgentDeployment[]> {
    const at = now();
    const rows: AgentDeployment[] = [];
    for (const a of this.s.agents.values()) {
      rows.push({
        deploymentId: `d_${a.definition.agentId}` as AgentDeployment["deploymentId"],
        agentId: a.definition.agentId,
        versionId: `v_${a.definition.agentId}_3` as AgentDeployment["versionId"],
        target: a.definition.deployment,
        state: (a.deploymentState ?? "stopped") as AgentDeployment["state"],
        createdAt: at,
        updatedAt: at,
      });
    }
    return rows;
  }

  // ---- Models ----

  async listModels(): Promise<ModelOption[]> {
    return [
      { modelId: "gpt-4.1", providerId: "p_openai", displayName: "OpenAI · GPT-4.1", byok: false, available: true },
      { modelId: "claude-sonnet-4", providerId: "p_anthropic", displayName: "Anthropic · Claude Sonnet 4", byok: true, available: true },
      { modelId: "grok-4", providerId: "p_xai", displayName: "xAI · Grok 4", byok: true, available: true },
      { modelId: "deepseek-v4", providerId: "p_deepseek", displayName: "DeepSeek · V4", byok: true, available: true },
      { modelId: "mox-agent", providerId: "p_mox", displayName: "Mox · mox-agent", byok: false, available: false },
    ];
  }

  async testProviderConnection(providerId: string): Promise<{ ok: boolean; reason?: string }> {
    if (providerId === "p_mox") {
      return { ok: false, reason: "not-configured: no Mox-included inference backend connected yet" };
    }
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true };
  }

  async listCliEngines(): Promise<CliEngineRow[]> {
    // Mirrors the authoritative tiers from @mox/model-gateway CLI_ENGINES;
    // hosted connection state arrives with the deployments/CLI prompt (10).
    return [
      { engineId: "codex", displayName: "Codex CLI", supportTier: "OFFICIAL", state: "not-connected" },
      { engineId: "claude-code", displayName: "Claude Code", supportTier: "API_ONLY", state: "not-connected" },
      { engineId: "gemini-cli", displayName: "Gemini CLI", supportTier: "EXPERIMENTAL", state: "blocked-by-flag" },
      {
        engineId: "grok-cli",
        displayName: "Grok CLI",
        supportTier: "UNSUPPORTED",
        state: "unsupported",
        reason: "use xAI API keys instead",
      },
    ];
  }

  // ---- Integrations & channels ----

  async listIntegrations(): Promise<Array<{ integrationId: string; displayName: string; connected: boolean }>> {
    return [
      { integrationId: "i_github", displayName: "GitHub", connected: true },
      { integrationId: "i_notion", displayName: "Notion", connected: false },
      { integrationId: "i_composio", displayName: "Composio", connected: false },
      { integrationId: "i_n8n", displayName: "n8n", connected: true },
    ];
  }

  async toggleIntegration(integrationId: string, connected: boolean): Promise<void> {
    void integrationId;
    void connected;
  }

  async listChannels(): Promise<Array<{ channelId: string; displayName: string; kind: string; connected: boolean }>> {
    return [
      { channelId: "ch_web", displayName: "Web chat", kind: "web", connected: true },
      { channelId: "ch_whatsapp", displayName: "WhatsApp", kind: "whatsapp", connected: true },
      { channelId: "ch_slack", displayName: "Slack", kind: "slack", connected: false },
      { channelId: "ch_telegram", displayName: "Telegram", kind: "telegram", connected: false },
    ];
  }

  // ---- Usage/billing/settings ----

  async getUsage(): Promise<UsageRow[]> {
    return [
      { metric: "tokens-in", quantity: 1_284_112, unit: "tokens" },
      { metric: "tokens-out", quantity: 302_889, unit: "tokens" },
      { metric: "computer-minutes", quantity: 214, unit: "min" },
      { metric: "voice-minutes", quantity: 36, unit: "min" },
      { metric: "actions", quantity: 5_402, unit: "actions" },
    ];
  }

  async listInvoices(): Promise<InvoiceRow[]> {
    return [
      { invoiceId: "in_2026_07", periodStart: "2026-07-01", periodEnd: "2026-07-31", amountCents: 8_900, currency: "EUR", state: "paid" },
      { invoiceId: "in_2026_08", periodStart: "2026-08-01", periodEnd: "2026-08-31", amountCents: 11_240, currency: "EUR", state: "open" },
    ];
  }

  async getEntitlements(): Promise<Entitlements> {
    // Demo workspace entitlements; hosted product resolves from plan/contract
    // via the entitlements service (Prompt 08). Gates stay hooks in the UI.
    return { computer: true, terminal: true, voice: false, rooms: true, customModels: true };
  }

  // ---- Computer (gateway contract) ----

  async computerSnapshot(agentId: string): Promise<ComputerSnapshot | undefined> {
    return this.s.computerSessions.get(agentId);
  }

  async computerTakeover(agentId: string, take: boolean, takenBy: string): Promise<ComputerSnapshot> {
    const snap = this.requireSession(agentId);
    snap.humanControl = take;
    snap.state = take ? "paused" : "active";
    snap.frameLabel = take ? `human control (${takenBy})` : "reference frame · isolated Chromium (demo runtime)";
    snap.capturedAt = now();
    return { ...snap };
  }

  async computerRestart(agentId: string): Promise<ComputerSnapshot> {
    const prev = this.requireSession(agentId);
    const next: ComputerSnapshot = { ...prev, sessionId: `cs_${randomUUID().slice(0, 8)}`, state: "active", humanControl: false, capturedAt: now() };
    this.s.computerSessions.set(agentId, next);
    return next;
  }

  // ---- Files & logs ----

  async listFiles(agentId: string): Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>> {
    void agentId;
    return [
      { path: "workspace/report-draft.md", sizeBytes: 12_488, updatedAt: now() },
      { path: "workspace/sources.list.json", sizeBytes: 2_140, updatedAt: now() },
      { path: "workspace/.gitignore", sizeBytes: 64, updatedAt: now() },
    ];
  }

  async filePreview(agentId: string, path: string): Promise<string> {
    void agentId;
    if (path.endsWith(".md")) return "# Draft\n\nCompiled from today's research turns.";
    if (path.endsWith(".json")) return '[\n  { "url": "https://example.com/quarterly-report", "checked": true }\n]';
    return "";
  }

  async getLogs(agentId: string): Promise<Array<{ at: string; level: "info" | "warn" | "error"; line: string }>> {
    const name = this.requireAgent(agentId).definition.identity.displayName;
    return [
      { at: now(), level: "info", line: `[${name}] runtime heartbeat ok` },
      { at: now(), level: "warn", line: `[${name}] egress proxy latency elevated (480ms)` },
      { at: now(), level: "info", line: `[${name}] policy allow: computer.read` },
    ];
  }

  // ---- internals ----

  private requireAgent(agentId: string): AgentSummary {
    const a = this.s.agents.get(agentId);
    if (!a) throw new Error(`unknown agent: ${agentId}`);
    return a;
  }

  private requireSession(agentId: string): ComputerSnapshot {
    const s = this.s.computerSessions.get(agentId);
    if (!s) throw new Error(`no computer session for ${agentId}`);
    return s;
  }

  private ensureThread(agentId: string, threadId: string): void {
    if (!this.s.threads.has(agentId)) this.s.threads.set(agentId, []);
    const list = this.s.threads.get(agentId) as Array<{ threadId: string; title?: string; agentId: string }>;
    if (!list.some((t) => t.threadId === threadId)) list.unshift({ threadId, title: "Direct chat", agentId });
    if (!this.s.messages.has(threadId)) this.s.messages.set(threadId, []);
    if (!this.s.events.has(threadId)) this.s.events.set(threadId, []);
  }

  private requiresComputerApproval(agentId: string): boolean {
    const a = this.requireAgent(agentId);
    return a.definition.permissions.toolPolicy !== "allow-all" &&
      (a.definition.permissions.requireApprovalFor?.includes("computer") ?? false);
  }

  private pushMessage(threadId: string, msg: ChatMessage): void {
    const list = this.s.messages.get(threadId) ?? [];
    list.push(msg);
    this.s.messages.set(threadId, list);
  }

  private appendEvent(threadId: string, e: AgentEvent): void {
    const list = this.s.events.get(threadId) ?? [];
    list.push(e);
    this.s.events.set(threadId, list);
  }

  /**
   * Simulated but contract-faithful run: canonical events only, streaming
   * deltas, an optional approval gate, tool activity, honest cancellation.
   */
  private async simulateRun(args: {
    runId: string;
    turnId: string;
    agentId: string;
    agentName: string;
    threadId: string;
    text: string;
    requiresApproval: boolean;
    isCancelled: () => boolean;
    onEvent: (e: AgentEvent) => void;
  }): Promise<void> {
    const { turnId, agentId, threadId, onEvent, isCancelled } = args;
    const emit = (e: { type: AgentEvent["type"] } & Record<string, unknown>) => {
      const full = {
        eventId: EventId.parse(randomUUID()),
        agentId,
        threadId,
        at: now(),
        ...e,
      } as AgentEvent;
      this.appendEvent(threadId, full);
      onEvent(full);
      return full;
    };

    const assistantId = randomUUID();
    let reply = "";

    emit({ type: "turn.started", turnId: TurnId.parse(turnId), input: { text: args.text } });

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    if (args.requiresApproval) {
      const approvalId = ApprovalId.parse(randomUUID());
      const request: ApprovalRequest = {
        approvalId,
        orgId: OrgId.parse("org_demo"),
        agentId,
        threadId,
        kind: "computer-action",
        summary: `${args.agentName} wants to use its browser for “${args.text}”.`,
        payload: { action: { kind: "navigate", url: guessUrl(args.text) }, effectClass: "navigate" },
        state: "open",
        requestedAt: now(),
      };
      this.s.approvals.set(approvalId, request);
      emit({ type: "approval.opened", approvalId, summary: request.summary });

      // Block until the canonical ApprovalRequest reaches a terminal state.
      // Poll the record (not a waiter map) so resolutions that arrive
      // synchronously during emit are observed too.
      const settle = (): "approved" | "denied" | undefined => {
        const st = this.s.approvals.get(approvalId)?.state;
        if (st === "approved") return "approved";
        if (st === "denied" || st === "expired" || st === "cancelled") return "denied";
        return undefined;
      };
      let outcome = settle();
      const deadline = Date.now() + 60_000; // canonical expiry
      while (outcome === undefined) {
        if (Date.now() > deadline) {
          request.state = "expired";
          outcome = "denied";
          break;
        }
        await wait(20);
        outcome = settle();
      }
      emit({ type: "approval.resolved", approvalId, outcome });
      if (outcome === "denied") {
        reply = "Understood — I won't use the browser for that. Ask me again anytime.";
        await streamText(reply, emit, assistantId, turnId, isCancelled, wait);
        finishTurn(emit, turnId, reply, isCancelled);
        return;
      }
      emit({ type: "tool.requested", turnId, toolName: "computer", input: { action: { kind: "navigate", url: guessUrl(args.text) } } });
      await wait(250);
      emit({
        type: "tool.completed",
        turnId,
        toolName: "computer",
        output: { ok: true, url: guessUrl(args.text), note: "via Mox Computer Gateway (demo)" },
        ok: true,
      });
    }

    if (/status|servers|health/i.test(args.text)) {
      emit({ type: "tool.requested", turnId, toolName: "ops.report", input: {} });
      await wait(200);
      emit({ type: "tool.completed", turnId, toolName: "ops.report", output: { servers: 3, degraded: 1 }, ok: true });
      reply = "3 servers up; **hetzner #2210** is degraded (CPU 96%). Want me to drain it?";
    } else {
      reply = args.requiresApproval
        ? `Opened **${guessUrl(args.text)}** in my isolated browser and skimmed the summary. Key point: revenue is up 14% QoQ.`
        : `On it. Here's what I found for “${args.text}”: nothing needs escalation right now.`;
    }
    await streamText(reply, emit, assistantId, turnId, isCancelled, wait);
    finishTurn(emit, turnId, reply, isCancelled);
  }
}

async function streamText(
  reply: string,
  emit: (e: { type: AgentEvent["type"] } & Record<string, unknown>) => void,
  messageId: string,
  turnId: string,
  isCancelled: () => boolean,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const chunks = reply.match(/.{1,24}/gs) ?? [];
  for (const chunk of chunks) {
    if (isCancelled()) return;
    emit({ type: "message.delta", messageId, turnId, delta: chunk });
    await wait(40);
  }
  emit({ type: "message.completed", messageId, turnId, text: reply });
}

function finishTurn(
  emit: (e: { type: AgentEvent["type"] } & Record<string, unknown>) => void,
  turnId: string,
  reply: string,
  isCancelled: () => boolean,
): void {
  if (isCancelled()) {
    emit({ type: "turn.failed", turnId, error: "cancelled by user" });
    return;
  }
  emit({ type: "turn.completed", turnId, output: reply });
}

function guessUrl(text: string): string {
  const m = /https?:\/\/[^\s]+/i.exec(text);
  return m?.[0] ?? "https://example.com/quarterly-report";
}
