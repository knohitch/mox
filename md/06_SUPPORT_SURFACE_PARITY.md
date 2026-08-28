# 06 — SUPPORT SURFACE PARITY

## Objective

Make the Support surface expose every support-safe Mox capability that authorized Support staff should see, while preserving least privilege.

Support is not a smaller Admin panel and must not gain Admin-only financial/secret/runtime authority.

---

# A. SUPPORT INVENTORY

From the Phase 01 feature inventory, identify everything classified:

- `SUPPORT_VISIBLE`
- `SUPPORT_CAPABILITY_GATED`

Cross-check:
- support routes
- support capabilities
- support API client
- Support navigation
- current Support views
- support notes/audit behavior

---

# B. CUSTOMER LOOKUP

Ensure Support can:
- search customer/workspace
- open customer detail
- see support-safe identity/workspace metadata
- see subscription lifecycle state necessary for diagnosis
- see safe server state
- see safe agent/deployment state
- see support notes
- see recent support-safe activity

Ensure Support cannot see:
- provider credentials
- system credentials
- customer plaintext secrets
- payment provider secrets
- wholesale costs
- margins
- Admin-only feature flag controls
- staff authority
- raw sensitive audit payloads
- unrestricted runtime commands

---

# C. SUPPORT NOTES

Current support note creation is audited.

Ensure:
- clear Add note UX
- note author/time
- reasonable length validation
- no HTML/script injection
- no cross-org note IDOR
- refresh/persistence

If edit/delete does not exist in the domain, do not invent it without an audit model.

---

# D. DIAGNOSTICS

Scan Mox-owned code for support-safe diagnostics currently trapped behind Admin or backend-only data.

Potential support-safe projections may include:
- current subscription state
- suspension reason safe for support
- server lifecycle/error summary
- Mox Node last-seen/health summary if safe
- agent runtime status
- deployment state
- connection configured/not-configured state
- recent customer-visible notification failures
- provider incident status where relevant to customer issue

Create **support-safe projections**, not raw Admin payload reuse.

Support must not receive:
- wholesale/provider account IDs unless genuinely needed and approved
- provider secrets
- margin/cost ledger
- global customer data outside lookup need
- Admin actions

---

# E. SUPPORT ACTIONS

Only surface actions supported by explicit Support capability.

Examples:
- add support note
- possibly customer-safe diagnostic refresh/reconcile if there is an existing least-privilege service authority

Do not surface:
- suspend/reactivate customer unless Support role is explicitly designed for it
- compute lifecycle
- billing provider mutation
- plan mutation
- staff management
- feature flag mutation
- system intelligence mutation

If the code has a Support capability for an action that UI omits, surface it with tests.

---

# F. NAVIGATION / DEEP LINKS

Every support feature must be discoverable in Support UI.

Do not rely on hidden routes.

Customer/Admin shells must never show Support navigation.

---

# G. TESTS

Add:
- Support nav capability tests
- customer lookup
- support detail
- note persistence/audit
- cross-org/IDOR safety
- Support cannot access Admin endpoints
- sensitive field absence
- diagnostics safe projection

---

# REPORT

Create:

`docs/verification/UI_PARITY_06_SUPPORT.md`

Local commit after green verification:

`feat(ui-parity): complete support capability surfaces`
