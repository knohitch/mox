# Prompt 10 — Agent builder, deployments, Developer Mode and CLI

## What was built

- `services/agent-control`
  - **Simple Mode builder** (`builder.ts`): step-based no-code input compiles
    into the canonical `AgentDefinition` (identity, instructions, model
    selection "provider/model", tools, knowledge, browser/computer, channels,
    schedules, target server, voice, permission presets safe/balanced/full).
  - **Developer Mode**: raw validated `AgentDefinition` editing via the same
    zod schema — both modes round-trip one engine (Rule 5).
  - **Versioning**: drafts editable; publish freezes immutable revision N+1;
    history + `diffVersions` summaries; rollback re-pins older revisions and
    re-reconciles; running deployments are never invisibly mutated (new
    deployment stops the previous one explicitly).
  - **Deployment targets**: Mox DSH runtime image (default or
    metadata.runtimeImage override), external AG-UI endpoints, custom Docker,
    Git-based images resolve through a pluggable `DeployImageResolver`;
    customer-vps targets reconcile via signed commands to Mox Node through an
    abstracted `NodeChannel`.
  - **Entitlement gates**: developer_mode publish gate, org-wide concurrent
    agent limits, cli_sessions terminal gate — checked against the
    Entitlement Service, never plan-name strings.
  - **Browser terminal**: audited sessions structurally restricted to servers
    owned by the caller's org; control-plane hosts are unaddressable.
- `apps/cli` — `mox` command surface: login/logout/whoami, orgs list, servers
  list/get, agents list/get/create/update, deploy (--revision), deployment
  status, logs, models connections, channels list, integrations list,
  terminal. Bearer-token API client; all authorization enforced server-side.
- DB: `browser_terminal_sessions` audit table (+ migration 0004).

## Tests

19 new tests: Simple→canonical compilation, Simple/Developer round-trip on one
schema, malformed model rejection, permission presets, immutable versioning +
diff, unpublished-deploy refusal, developer-mode entitlement gate, concurrent
agent limit enforcement, pinned-revision deployment reconcile to running via
node channel, rollback semantics with explicit stop+apply, owned-server-only
terminal access, cli_sessions denial, CLI auth/endpoints/flags/help/errors.
