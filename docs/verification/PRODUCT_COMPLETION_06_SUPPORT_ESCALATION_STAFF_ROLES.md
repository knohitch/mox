# PRODUCT COMPLETION — PHASE 06
# Support Escalation + Staff Role Unification Verification

Starting SHA: `259bd11`

## Summary

Support escalations are now a durable, audited workflow. The `support_escalations` table stores escalation records with full lifecycle (open → acknowledged → investigating → resolved → closed). The Support Console's Escalations section is now functional with create, list, and status transition capabilities. Staff role vocabulary has been extended with `billing_admin` and `ops_admin`.

## What Was Built

### A. Durable Support Escalations

**Database:**
- `support_escalations` table with: id, orgId, createdByUserId, assignedUserId, severity, category, title, description, status, resolutionNote, resolvedAt, timestamps
- `escalation_status` enum: open, acknowledged, investigating, resolved, closed
- Migration: `0021_support_escalations.sql`
- Schema: `packages/database/src/schema/identity-staff.ts`

**API Endpoints:**
| Endpoint | Method | Gate | Description |
|----------|--------|------|-------------|
| `/api/support/escalations` | GET | `support.escalate` | List escalations, optional orgId filter |
| `/api/support/escalations` | POST | `support.escalate` | Create escalation with severity/category/title/description |
| `/api/support/escalations/:id` | POST | `support.escalate` | Update status/assignment/resolution |

All mutations are audit-logged via `appendSupportAudit`.

**UI — `EscalationPanel` in `App.tsx`:**
- Create form with severity (low/medium/high/critical), category (general/billing/technical/security/compliance), title, description
- Escalation list with status badges, severity, category, date
- Status transition buttons: Acknowledge → Investigating → Resolve → Close
- Resolution notes display
- Gated by `support.escalate` capability (support_manager only)

### B. Staff Role Unification

**Database enum extended:**
- `staff_role` enum now includes: `superadmin`, `platform_admin`, `support_manager`, `support_agent`, `billing_admin`, `ops_admin`
- Migration: `0021_support_escalations.sql` (ALTER TYPE ADD VALUE)

**Capability mapping preserved:**
- `billing_admin`: billing/plans/contracts scope
- `ops_admin`: compute/intelligence/runtime/operations scope
- Legacy config roles mapped through `PLATFORM_ROLE_CAPABILITIES`
- No silent promotion of legacy roles

## Verification Results

| Gate | Result |
|------|--------|
| `tsc -b --force packages/database` | PASS |
| `tsc -b --force services/control-plane` | PASS |
| `tsc -b --force apps/web` | PASS |
| `pnpm test` | PASS (85 files, 736 tests passed, 107 skipped) |

## Files Modified

- `packages/database/src/schema/identity-staff.ts` — escalation table + enum extension
- `packages/database/migrations/0021_support_escalations.sql` — migration
- `services/control-plane/src/api.ts` — escalation endpoints + import
- `apps/web/src/api/types.ts` — `SupportEscalation` type + API methods
- `apps/web/src/api/http-api.ts` — escalation HTTP methods
- `apps/web/src/api/demo-api.ts` — escalation demo fixtures
- `apps/web/src/api/store.tsx` — escalation methods in failingApi
- `apps/web/src/uiStudio/mockStore.ts` — escalation Studio fixtures
- `apps/web/src/App.tsx` — `EscalationPanel` component
- `md/05_MODEL_PROBES_AND_CLI_RUNTIME_STATE.md` — marked as done
