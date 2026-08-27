/**
 * Integration Gateway (Prompt 11): provider-neutral app integrations.
 *
 * MCP, Composio, native OAuth/API providers, Make.com and n8n webhooks and
 * generic webhook/token integrations all normalize into Mox ToolDefinitions.
 * Every tool grant is explicit per org/user/agent — nothing is implicit.
 */

import { ToolDefinition, type JsonValue } from "@mox/contracts";
import { safeOutboundFetch, UnsafeOutboundUrlError } from "@mox/security";

export type IntegrationProviderKind = "mcp" | "composio" | "oauth-api" | "make" | "n8n" | "webhook-token";

export interface IntegrationConnection {
  connectionId: string;
  orgId: string;
  providerKind: IntegrationProviderKind;
  displayName: string;
  /** Vault reference for OAuth tokens / API keys; never the secret itself. */
  secretRef?: string;
  /** Webhook target URL for make/n8n/webhook providers. */
  webhookUrl?: string;
  /** Provider-specific config (MCP server descriptor, Composio auth id...). */
  config: Record<string, unknown>;
  status: "connected" | "disconnected" | "error";
}

export interface IntegrationProvider {
  readonly kind: IntegrationProviderKind;
  readonly displayName: string;
  /**
   * Produce the Mox tools this connection exposes. Providers must be
   * capability-honest: an unavailable catalogue yields no tools, not fakes.
   */
  listTools(connection: IntegrationConnection): Promise<ToolDefinition[]>;
  /** Execute one tool call through the provider. */
  invoke(
    connection: IntegrationConnection,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: JsonValue; error?: string }>;
}

// ---- Providers -----------------------------------------------------------------

export interface McpServerDescriptor {
  serverName: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonValue;
    dangerLevel?: ToolDefinition["dangerLevel"];
  }>;
}

/** Model Context Protocol connector backed by a server descriptor. */
export class McpProvider implements IntegrationProvider {
  readonly kind = "mcp" as const;
  readonly displayName = "Model Context Protocol";

  constructor(private readonly fetchDescriptor?: (connection: IntegrationConnection) => Promise<McpServerDescriptor>) {}

  private async describe(connection: IntegrationConnection): Promise<McpServerDescriptor> {
    if (this.fetchDescriptor) return this.fetchDescriptor(connection);
    // Default: static descriptor shipped in connection config (self-hosted
    // stdio-style servers register their tool catalogues here).
    return (connection.config.server ?? { serverName: connection.displayName, tools: [] }) as McpServerDescriptor;
  }

  async listTools(connection: IntegrationConnection): Promise<ToolDefinition[]> {
    const descriptor = await this.describe(connection);
    void descriptor.serverName;
    return descriptor.tools.map((tool) =>
      ToolDefinition.parse({
        name: `mcp_${descriptor.serverName}_${tool.name}`,
        displayName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        dangerLevel: tool.dangerLevel ?? "network",
        requiresApproval: tool.dangerLevel === undefined ? true : tool.dangerLevel !== "read-only",
      }),
    );
  }

  async invoke(
    connection: IntegrationConnection,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: JsonValue; error?: string }> {
    void connection; void toolName; void input;
    // Execution rides the runtime's MCP client session; the gateway only
    // authorizes and audits. Report honestly until a session is bound.
    return { ok: false, output: null, error: "no_mcp_session_bound" };
  }
}

interface ComposioAction {
  name: string;
  display_name: string;
  description: string;
  parameters: JsonValue;
  dangerLevel?: ToolDefinition["dangerLevel"];
}

/**
 * Composio broker: adapts Composio action catalogues to Mox tools.
 * Ported from OpenMaus' Composio integration concept, provider-neutral.
 */
export class ComposioProvider implements IntegrationProvider {
  readonly kind = "composio" as const;
  readonly displayName = "Composio";

  constructor(private readonly listActions?: (connection: IntegrationConnection) => Promise<ComposioAction[]>) {}

  async listTools(connection: IntegrationConnection): Promise<ToolDefinition[]> {
    const actions =
      this.listActions !== undefined
        ? await this.listActions(connection)
        : ((connection.config.actions ?? []) as ComposioAction[]);
    return actions.map((action) =>
      ToolDefinition.parse({
        name: `composio_${action.name}`,
        displayName: action.display_name,
        description: action.description,
        inputSchema: action.parameters,
        dangerLevel: action.dangerLevel ?? "write",
        requiresApproval: (action.dangerLevel ?? "write") !== "read-only",
      }),
    );
  }

  async invoke(
    connection: IntegrationConnection,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: JsonValue; error?: string }> {
    if (!connection.webhookUrl && !connection.secretRef) {
      return { ok: false, output: null, error: "composio_connection_unconfigured" };
    }
    void toolName; void input;
    return { ok: false, output: null, error: "composio_execution_requires_bound_runtime_session" };
  }
}

/** Outbound-webhook automation platforms (Make.com / n8n / generic). */
export class WebhookAutomationProvider implements IntegrationProvider {
  readonly kind: IntegrationProviderKind;
  readonly displayName: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly resolve?: (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
  private readonly resolveSecret?: (secretRef: string) => Promise<string | undefined>;

  constructor(
    kind: "make" | "n8n" | "webhook-token",
    options: {
      fetchImpl?: typeof fetch;
      resolve?: (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
      resolveSecret?: (secretRef: string) => Promise<string | undefined>;
    } = {},
  ) {
    this.kind = kind;
    this.displayName =
      kind === "make" ? "Make.com" : kind === "n8n" ? "n8n" : "Generic Webhook/API Token";
    // Explicit fixture seam only. Default/production execution MUST leave
    // this undefined so safeOutboundFetch uses its pinned node:http/https path.
    this.fetchImpl = options.fetchImpl;
    this.resolve = options.resolve;
    this.resolveSecret = options.resolveSecret;
  }

  async listTools(connection: IntegrationConnection): Promise<ToolDefinition[]> {
    if (!connection.webhookUrl) return []; // honest: nothing callable configured
    const scenario = String(connection.config.scenario ?? connection.displayName);
    return [
      ToolDefinition.parse({
        name: `${this.kind}_trigger_${scenario}`,
        displayName: `Trigger ${this.displayName} scenario "${scenario}"`,
        description: `Sends a JSON payload to the ${this.displayName} webhook for scenario ${scenario}.`,
        inputSchema: {
          type: "object",
          properties: { payload: { type: "object", additionalProperties: true } },
          required: [],
        },
        dangerLevel: "network",
        requiresApproval: false,
      }),
    ];
  }

  async invoke(
    connection: IntegrationConnection,
    _toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: JsonValue; error?: string }> {
    if (!connection.webhookUrl) return { ok: false, output: null, error: "webhook_not_configured" };
    let bearer: string | undefined;
    if (connection.secretRef) {
      if (!this.resolveSecret) return { ok: false, output: null, error: "secret_resolution_not_configured" };
      bearer = await this.resolveSecret(connection.secretRef);
      if (!bearer) return { ok: false, output: null, error: "secret_not_found" };
    }
    try {
      const { response } = await safeOutboundFetch(connection.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(input.payload ?? {}),
      }, {
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        ...(this.resolve ? { resolve: this.resolve } : {}),
        allowedPorts: [443],
      });
      return response.ok
        ? { ok: true, output: { status: response.status } }
        : { ok: false, output: null, error: `webhook HTTP ${response.status}` };
    } catch (error) {
      if (error instanceof UnsafeOutboundUrlError) {
        return { ok: false, output: null, error: `webhook_url_denied:${error.reason}` };
      }
      return { ok: false, output: null, error: String(error) };
    }
  }
}

/** Native OAuth/API provider template (e.g. GitHub, HubSpot). */
export class OAuthApiProvider implements IntegrationProvider {
  readonly kind = "oauth-api" as const;
  readonly displayName: string;

  private readonly catalogue: Array<{
    name: string;
    description: string;
    schema: JsonValue;
    dangerLevel: ToolDefinition["dangerLevel"];
  }>;

  constructor(displayName: string, catalogue: OAuthApiProvider["catalogue"]) {
    this.displayName = displayName;
    this.catalogue = catalogue;
  }

  async listTools(connection: IntegrationConnection): Promise<ToolDefinition[]> {
    if (!connection.secretRef) return [];
    return this.catalogue.map((tool) =>
      ToolDefinition.parse({
        name: `api_${tool.name}`,
        displayName: tool.name,
        description: tool.description,
        inputSchema: tool.schema,
        dangerLevel: tool.dangerLevel,
        requiresApproval: tool.dangerLevel !== "read-only",
      }),
    );
  }

  async invoke(): Promise<{ ok: boolean; output: JsonValue; error?: string }> {
    return { ok: false, output: null, error: "oauth_api_execution_requires_bound_runtime_session" };
  }
}
