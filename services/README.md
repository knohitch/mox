# services/

Mox-owned backend services (control plane, billing, reconciliation, policy).
Intentionally empty in Prompt 01 — no billing/compute implementation yet.
Services depend on `@mox/*` packages only; never on imported source trees.