# Mox Architecture — Hard Rules

Status: **Binding architecture rules.** These rules are binding for all future
Mox work and are checked against active Mox authorities, not historical
implementation sources.

Required third-party license, notice and provenance records live under
`third_party/` and internal provenance documentation. Product and runtime
surfaces use Mox names only.

---

## Rule 1 — One authority per concern

Every concern in the platform (identity, billing, entitlements, compute,
agent definitions, execution, credentials, audit, …) has **exactly one final
authority**: one module that owns the truth and whose decision is final.
Other components may cache, project, or propose, but only the authority
decides. The full list of concerns and their authorities is maintained in
[`AUTHORITY_MATRIX.md`](AUTHORITY_MATRIX.md). If a concern is not in the
matrix, it must be added before code that touches it lands.

Consequences:

- No dual writes to the same truth from two components.
- Cross-concern reads go through the authority's interface, not around it.
- Conflicts between components are resolved in favor of the authority, always.

## Rule 2 — Provider-specific code lives behind interfaces

Model providers, agent runtimes (Claude Code, Codex, LangGraph, AG-UI),
computer/browser backends, voice engines, channel transports, and payment
processors are all **providers**. Mox code depends on Mox interfaces;
provider SDKs and CLIs appear only inside adapter modules that implement
those interfaces.

Consequences:

- No provider import outside its adapter boundary.
- Swapping or adding a provider must not require changes outside the adapter
  plus registration.
- Reference implementations and provider SDKs are treated as adapter sources,
  not as the architecture: code is ported *behind* interfaces, never wired in
  directly.

## Rule 3 — The customer VPS is untrusted

Any machine that Mox does not fully control — customer VPS, customer laptop,
customer container host — is treated as hostile. The server must never trust
attestation, state reports, or local data from it without verification.

Consequences:

- Desired state flows *to* the VPS; confirmed state flows *back* and is
  verified before it is trusted.
- Credentials needed on a VPS are scoped, short-lived where possible, and
  revocable server-side.
- Billing, entitlement, and usage truth never originates on the VPS.
- A compromised VPS must not be able to read other tenants' data, mint
  entitlements, or forge audit records.

## Rule 4 — External side effects are idempotent and audited

Every action that leaves Mox's own process boundary — model API calls,
computer/browser actions, shell commands, emails, webhooks, payments,
provisioning — must be:

1. **Idempotent or safely retryable**: retries must not double-charge,
   double-provision, or double-send. Use idempotency keys or natural
   idempotency, and record the key.
2. **Audited**: an audit record exists for every attempt (allowed, refused,
   and failed), written before or atomically with the effect — never only
   after success.

Consequences:

- No fire-and-forget external calls without an audit row.
- Policy decisions (allow/deny) are recorded with the rule that decided them.
- Secrets never appear in audit records or transcripts; record that a secret
  was used and its shape, not its value.

## Rule 5 — Simple and Developer modes compile to one `AgentDefinition`

Mox exposes two authoring experiences — **Simple** (guided, form/template
driven) and **Developer** (full definition, code-level control). Both are
front-ends that compile to the **same single `AgentDefinition` artifact**.
There is no separate runtime path, no separate storage shape, and no
behavior that exists in one mode but cannot be expressed in the other.

Consequences:

- The `AgentDefinition` schema is the single interchange format; both modes
  are compilers/validators over it.
- A definition authored in Simple mode must round-trip through Developer
  mode and vice versa.
- Execution, versioning, and audit operate on `AgentDefinition` only; they
  never learn which mode produced it.

## Rule 6 — The web app is primary

The web application is the primary Mox surface. Desktop (Electron), mobile,
CLI, and companion surfaces are secondary clients over the same APIs and
same authorities. Features land web-first; secondary surfaces consume the
same interfaces and never fork business logic.

Consequences:

- No business logic may exist only in a desktop/mobile code path.
- Secondary-client experience and device integration patterns must be
  re-hosted behind Mox's web-first APIs.

## Rule 7 — Reference/provenance material is not production

Reference snapshots and provenance material remain non-production until a
final retirement change is explicitly approved. Until then:

- Do not edit them to make Mox code work; port code *out* into Mox-owned
  modules instead and record provenance in the approved legal/provenance
  locations.
- Their package managers, lockfiles, and toolchains stay as-is; do not merge
  workspaces or hoist dependencies across trees.
- Retirement happens only at the end of consolidation, as its own reviewed
  change, after every required adapted item has landed and its tests pass in
  its new Mox-owned home.

---

## How these rules are enforced

- **Review**: every PR touching consolidation must state which rules it
  could affect and why it complies.
- **Authority matrix**: changes that introduce a second writer for any
  matrix concern are rejected.
- **Provenance**: every file copied or adapted from an imported tree carries
  attribution per `docs/consolidation/PROVENANCE.md`.
- **Baseline**: pre-existing failures are tracked in
  `docs/consolidation/BASELINE.md`; a change may not silently convert a
  baseline failure into a different failure or hide it.
