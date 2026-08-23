# Security Boundaries

## Trust Zones

```
┌─────────────────────────────────────────────────────────────┐
│ UNTRUSTED BROWSER / CLIENT                                  │
│ apps/web, user input, uploads, API parameters, local state   │
│ Never authoritative for identity, org, billing, entitlement, │
│ admin capability, provider state, model state, or telemetry. │
└──────────────────────┬──────────────────────────────────────┘
                       │ authenticated HTTPS API calls
┌──────────────────────▼──────────────────────────────────────┐
│ TRUSTED SERVER-SIDE MOX CONTROL PLANE                       │
│ services/*, packages/*, runtime policy/config, migrations    │
│ Owns: auth, sessions, RBAC/capabilities, tenant isolation,   │
│ billing, entitlements, desired state, audit, vault refs.     │
└──────────────┬───────────────────────────┬──────────────────┘
               │ signed/node auth channel  │ verified/provider APIs
┌──────────────▼──────────────┐   ┌────────▼──────────────────┐
│ UNTRUSTED CUSTOMER VPS      │   │ EXTERNAL PROVIDERS         │
│ Mox Node telemetry, customer│   │ payment/compute/model APIs │
│ root, workloads, local files│   │ and webhooks are untrusted  │
│ are advisory until verified │   │ or semi-trusted inputs.     │
└─────────────────────────────┘   └───────────────────────────┘
```

## Non-Authoritative Inputs

- Browser/client assertions, route parameters, uploaded content, local storage,
  feature flags, and rendered UI state are untrusted until the server validates
  authentication, CSRF/session rules, authorization, tenant ownership, and input
  shape.
- Customer-root state, Mox Node telemetry, workload status, local node files,
  and node-provided identifiers are advisory. They cannot grant billing,
  entitlements, role privilege, ownership, provider authority, or policy bypass.
- Provider callbacks and webhooks are attacker-controlled network input until
  the server verifies provider authenticity, exact raw body requirements,
  freshness/replay rules, and server-derived amount/currency/resource bindings.
- Provider API responses are semi-trusted facts about the provider side, not
  authorization decisions. The control plane reconciles them against Mox-owned
  orders, subscriptions, ids, and idempotency records.

## Hard Boundaries

1. **Browser/client -> Control Plane**: apps/web is not trusted. Every protected
   access requires server-side auth, CSRF where applicable, PAT scope checks,
   tenant membership, and capability/RBAC checks. Client-visible state never
   creates role privilege or commercial entitlement.
2. **Tenant -> tenant**: every durable store query is scoped by `orgId` or an
   equivalent ownership check. Admin surfaces are separate server-side
   capabilities, not tenant API extensions.
3. **Control Plane -> customer VPS / Mox Node**: the node is an untrusted
   reporter. Enrollment uses a one-time hashed token and must be expiring,
   order/org/instance-bound, and consumed atomically. Heartbeats cannot mutate
   billing or entitlements. Enforcement such as suspend/cancel runs through
   provider-side authority when the node is unavailable or hostile.
4. **Control Plane -> providers**: webhooks require authentic provider
   verification, exact raw body where required, replay/idempotency protection,
   and exact server-derived amount/currency reconciliation. Redirects grant
   nothing.
5. **Agents/tools/computer/shell/files -> world**: tool calls require policy,
   ownership, entitlement, and audit checks. Browser/computer sessions, shell,
   terminal, and filesystem access are never authorized by client assertions or
   node-local state alone.
6. **Outbound targets -> network**: attacker-controlled URLs pass SSRF and
   egress policy checks before any fetch. Credentials in URLs, private/link
   local/metadata targets, non-HTTPS targets, and disallowed ports fail closed.
7. **Secrets -> everything else**: secrets live server-side or in Mox Vault.
   Databases store references/fingerprints, not material. Secrets are never
   exposed to the browser, query strings, logs, analytics, runtime events, or
   normal admin read APIs.
8. **Unsupported capability -> caller**: missing providers, probes, terminal
   execution, model connections, runtime adapters, or deployment features fail
   honestly with explicit unavailable/not-configured results. Production never
   silently falls back to demo or in-memory authority.

See `docs/security/THREAT_MODEL.md` for scenario-by-scenario analysis and
`docs/verification/FULL_SYSTEM_MATRIX.md` for the proving tests.
