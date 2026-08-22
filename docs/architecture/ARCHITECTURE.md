# Mox Architecture — Hard Rules

Status: **Baseline (Step 1 of consolidation).** These rules are binding for all
future Mox work. They were written before any consolidation code exists, so that
later steps can be checked against them rather than argued into them.

The three imported source trees currently live untouched at the repository root:

- `OpenBot-main/` — control plane / computer / security donor (MIT, CopilotKit)
- `deepseek-harness-master/` — runtime kernel donor (MIT, DeepSeek)
- `OpenMausBot-main/` — GrokBot UX / provider / voice / device donor (Apache-2.0, Milind Soni)

See `docs/consolidation/BASELINE.md`, `docs/consolidation/PROVENANCE.md`, and
`docs/consolidation/SOURCE_CLASSIFICATION.md` for the inventory, license
obligations, and per-directory disposition.

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

Model providers, agent runtimes (Claude Code, Codex, LangGraph, AG-UI bots),
computer/browser backends, voice engines, channel transports, and payment
processors are all **providers**. Mox code depends on Mox interfaces;
provider SDKs and CLIs appear only inside adapter modules that implement
those interfaces.

Consequences:

- No provider import outside its adapter boundary.
- Swapping or adding a provider must not require changes outside the adapter
  plus registration.
- The imported trees are treated as adapter mines, not as the architecture:
  code is ported *behind* interfaces, never wired in directly.

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
- The imported OpenMausBot Electron/UX code is a donor for experience and
  device integration, to be re-hosted behind Mox's web-first APIs.

## Rule 7 — Imported source trees are not deleted until final retirement

`OpenBot-main/`, `OpenMausBot-main/`, and `deepseek-harness-master/` remain
in the repository, unmodified in behavior, until a **final retirement
prompt** is explicitly approved. Until then:

- Do not delete, rename, or move the three trees.
- Do not edit them to make Mox code work; port code *out* into Mox-owned
  modules instead (record provenance per `PROVENANCE.md`).
- Their package managers, lockfiles, and toolchains stay as-is; do not merge
  workspaces or hoist dependencies across trees.
- Retirement happens only at the end of consolidation, as its own reviewed
  change, after every KEEP/PORT/ADAPT item in `SOURCE_CLASSIFICATION.md`
  has landed and its tests pass in their new home.

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