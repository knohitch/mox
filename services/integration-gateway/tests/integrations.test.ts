import { describe, expect, it } from "vitest";
import { IntegrationGateway } from "../src/gateway.js";
import { ComposioProvider, McpProvider, OAuthApiProvider, WebhookAutomationProvider, type McpServerDescriptor } from "../src/providers.js";

async function gateway() {
  const gw = new IntegrationGateway();
  const descriptor: McpServerDescriptor = {
    serverName: String("files"),
    tools: [
      {
        name: "read_file",
        description: "Read a file from the workspace",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        dangerLevel: "read-only",
      },
      {
        name: "delete_file",
        description: "Delete a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        dangerLevel: "destructive",
      },
    ],
  };
  gw.registerProvider(new McpProvider(async () => descriptor));
  gw.registerProvider(new ComposioProvider());
  gw.registerProvider(new WebhookAutomationProvider("make"));
  gw.registerProvider(new WebhookAutomationProvider("n8n"));
  return gw;
}

describe("integration gateway", () => {
  it("normalizes MCP catalogues into Mox ToolDefinitions", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-mcp",
      orgId: "org-1",
      providerKind: "mcp",
      displayName: "Workspace Files MCP",
      config: { serverName: "files" },
      status: "connected",
    });
    const tools = await gw.listToolsForConnection("conn-mcp");
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp_files_delete_file", "mcp_files_read_file"]);
    // Danger levels survive normalization; destructive requires approval.
    const del = tools.find((t) => t.name === "mcp_files_delete_file")!;
    expect(del.dangerLevel).toBe("destructive");
    expect(del.requiresApproval).toBe(true);
  });

  it("lets MCP and Composio coexist with separate tool names", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-mcp2",
      orgId: "org-1",
      providerKind: "mcp",
      displayName: "MCP",
      config: { serverName: "github" },
      status: "connected",
    });
    await gw.connect({
      connectionId: "conn-composio",
      orgId: "org-1",
      providerKind: "composio",
      displayName: "Composio",
      config: {
        actions: [
          {
            name: "github_create_issue",
            display_name: "Create GitHub Issue",
            description: "Creates an issue",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      status: "connected",
    });
    const [mcp, composio] = await Promise.all([
      gw.listToolsForConnection("conn-mcp2"),
      gw.listToolsForConnection("conn-composio"),
    ]);
    expect(mcp[0]?.name).toContain("mcp_");
    expect(composio[0]?.name).toContain("composio_");
  });

  it("gives Make.com and n8n first-class connector paths", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-make",
      orgId: "org-1",
      providerKind: "make",
      displayName: "Make",
      config: { scenario: "lead-routing" },
      webhookUrl: "https://hook.make.test/xyz",
      status: "connected",
    });
    await gw.connect({
      connectionId: "conn-n8n",
      orgId: "org-1",
      providerKind: "n8n",
      displayName: "n8n",
      config: { scenario: "crm-sync" },
      webhookUrl: "https://n8n.example/webhook/crm-sync",
      status: "connected",
    });
    const make = await gw.listToolsForConnection("conn-make");
    const n8n = await gw.listToolsForConnection("conn-n8n");
    expect(make[0]?.name).toBe("make_trigger_lead-routing");
    expect(n8n[0]?.name).toBe("n8n_trigger_crm-sync");
  });

  it("requires explicit grants and enforces them per agent/user", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-grant",
      orgId: "org-g",
      providerKind: "mcp",
      displayName: "Files",
      config: { serverName: "fs" },
      status: "connected",
    });
    const tool = (await gw.listToolsForConnection("conn-grant"))[0]!.name;

    // Not granted → not authorized.
    expect(await gw.isToolAuthorized({ orgId: "org-g", toolName: tool, agentId: "agent-1" })).toBe(false);

    const grant = await gw.grantTool({
      orgId: "org-g",
      connectionId: "conn-grant",
      toolName: tool,
      agentId: "agent-1",
      grantedBy: "admin-1",
    });
    expect(await gw.isToolAuthorized({ orgId: "org-g", toolName: tool, agentId: "agent-1" })).toBe(true);

    // A different agent is NOT covered by the grant.
    expect(await gw.isToolAuthorized({ orgId: "org-g", toolName: tool, agentId: "agent-2" })).toBe(false);

    // Revocation ends authorization.
    await gw.revokeGrant("org-g", grant.grantId);
    expect(await gw.isToolAuthorized({ orgId: "org-g", toolName: tool, agentId: "agent-1" })).toBe(false);
  });

  it("refuses to grant tools that the connection does not expose", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-x",
      orgId: "org-x",
      providerKind: "composio",
      displayName: "Empty Composio",
      config: {},
      status: "connected",
    });
    await expect(
      gw.grantTool({ orgId: "org-x", connectionId: "conn-x", toolName: "composio_missing", agentId: "a", grantedBy: "admin" }),
    ).rejects.toThrow(/not exposed/);
  });

  it("reports disconnected connections as exposing no tools", async () => {
    const gw = await gateway();
    await gw.connect({
      connectionId: "conn-d",
      orgId: "org-d",
      providerKind: "make",
      displayName: "Make",
      config: { scenario: "s" },
      webhookUrl: "https://h",
      status: "connected",
    });
    await gw.disconnect("conn-d");
    expect(await gw.listToolsForConnection("conn-d")).toEqual([]);
  });

  it("OAuth API providers expose catalogue tools only when a token exists", async () => {
    const gw = new IntegrationGateway();
    gw.registerProvider(
      new OAuthApiProvider("GitHub", [
        {
          name: "create_issue",
          description: "Create an issue",
          schema: { type: "object", properties: {} },
          dangerLevel: "write",
        },
      ]),
    );
    await gw.connect({
      connectionId: "no-token",
      orgId: "o",
      providerKind: "oauth-api",
      displayName: "GitHub",
      config: {},
      status: "connected",
    });
    expect(await gw.listToolsForConnection("no-token")).toEqual([]);
    await gw.connect({
      connectionId: "with-token",
      orgId: "o",
      providerKind: "oauth-api",
      displayName: "GitHub",
      secretRef: "vault://gh-token",
      config: {},
      status: "connected",
    });
    expect((await gw.listToolsForConnection("with-token")).map((t) => t.name)).toEqual(["api_create_issue"]);
  });

  it("webhook automation blocks SSRF targets before any outbound fetch", async () => {
    let called = false;
    const provider = new WebhookAutomationProvider("webhook-token", {
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const result = await provider.invoke(
      {
        connectionId: "conn-ssrf",
        orgId: "org-1",
        providerKind: "webhook-token",
        displayName: "Internal",
        webhookUrl: "https://169.254.169.254/latest/meta-data/",
        config: {},
        status: "connected",
      },
      "webhook-token_trigger_Internal",
      { payload: { ok: true } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("webhook_url_denied");
    expect(called).toBe(false);
  });

  it("webhook automation resolves vault refs and never sends the ref as a bearer token", async () => {
    let authHeader = "";
    const provider = new WebhookAutomationProvider("webhook-token", {
      resolveSecret: async (ref) => (ref === "vault://integration/token" ? "real-secret-token" : undefined),
      fetchImpl: async (_url, init) => {
        authHeader = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
        return new Response("{}", { status: 200 });
      },
    });
    const result = await provider.invoke(
      {
        connectionId: "conn-webhook",
        orgId: "org-1",
        providerKind: "webhook-token",
        displayName: "Webhook",
        secretRef: "vault://integration/token",
        webhookUrl: "https://example.com/webhook",
        config: {},
        status: "connected",
      },
      "webhook-token_trigger_Webhook",
      { payload: { ok: true } },
    );
    expect(result.ok).toBe(true);
    expect(authHeader).toBe("Bearer real-secret-token");
    expect(authHeader).not.toContain("vault://");
  });

  it("webhook automation fails closed when a secret ref cannot be resolved", async () => {
    let called = false;
    const provider = new WebhookAutomationProvider("webhook-token", {
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const result = await provider.invoke(
      {
        connectionId: "conn-no-vault",
        orgId: "org-1",
        providerKind: "webhook-token",
        displayName: "Webhook",
        secretRef: "vault://integration/token",
        webhookUrl: "https://example.com/webhook",
        config: {},
        status: "connected",
      },
      "webhook-token_trigger_Webhook",
      { payload: { ok: true } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("secret_resolution_not_configured");
    expect(called).toBe(false);
  });
});
