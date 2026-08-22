# Security Boundaries (Prompts 14–15)

## Trust zones

```
┌─────────────────────────────────────────────────────────────┐
│ CONTROL PLANE (fully trusted)                               │
│ apps/web · services/* · packages/* · runtime/agent-runtime  │
│ Owns: identity, billing, entitlements, desired state, vault │
└──────────────┬───────────────────────────┬──────────────────┘
               │ outbound-only TLS         │ provider APIs
┌──────────────▼──────────────┐   ┌────────▼───────────────┐
│ CUSTOMER VPS (untrusted)    │   │ PROVIDERS (semi-trusted)│
│ Mox Node agent (advisory)   │   │ Contabo/Hetzner/models  │
│ customer holds root         │   │ credentials in Mox vault│
│ Docker workloads (sandboxed)│   └────────────────────────┘
└─────────────────────────────┘
```

## Hard boundaries

1. **Control plane ↔ customer VPS**: the node is an untrusted reporter.
   Enrollment = one-time hashed token; commands = server-signed HMAC with
   replay protection; heartbeats never influence billing/entitlements.
   Enforcement (suspend/cancel) always executes provider-side.
2. **Tenant ↔ tenant**: every store query filters by `orgId`; admin surfaces
   are a separate RBAC boundary, not part of tenant APIs.
3. **Agents ↔ world**: tool calls require explicit grants + approval flags;
   egress defaults to deny; outbound URLs pass the SSRF guard; browser ports
   are structurally internal.
4. **Billing ↔ presentation**: checkout redirects grant nothing; only
   verified webhooks mutate paid state.
5. **Secrets ↔ everything else**: vault-only storage, references in rows,
   scrubbed logs, per-account rotation.

See `docs/security/THREAT_MODEL.md` for scenario-by-scenario analysis and
`docs/verification/FULL_SYSTEM_MATRIX.md` for the proving tests.
