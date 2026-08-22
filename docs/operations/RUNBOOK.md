# Mox Operations Runbook

## Daily operations

### Subscriptions
- Inspect: Admin → billing summaries (`AdminService.listSubscriptions`).
- Suspend/reactivate: `adminSuspend` / `adminReactivate` (audited).
- Renewals run from period timestamps; investigate failures via invoice
  attempts (`failedRenewals`, grace windows).

### Compute fleet
- Server inventory: `AdminService.serverInventory()`.
- Provider health: `providerHealthReports()` + `packages/provider-health`
  scores; offline providers are auto-skipped by selection (never silently
  switched against contract constraints — eligibility gates run first).
- Account rotation: `rotateProviderCredential`; disable compromised accounts
  with reason.

### Abuse
- Cases: `platform-ops` open/list; emergency suspend executes provider-side
  and works while nodes are offline. Repeat offenders auto-flag at threshold.
- Deadlines tracked per case; customer responses recorded in the audit chain.

### Incidents
- Open with kind/scope, update through investigating→identified→monitoring→
  resolved. Critical incidents route notifications automatically.

## Common procedures

| Task | How |
|---|---|
| Change plan pricing/entitlements | `AdminService.publishPlanChange` — no deploy |
| Grant one-off entitlement | `grantEntitlementOverride` (expires supported) |
| Enterprise contract | `applyEnterpriseContract` — same entitlement engine |
| Rotate provider credential | vault write → `rotateProviderCredential` |
| Feature rollout | flags scoped global/region/plan/org/user/provider |
| Backup verify | `BackupService.runRestoreTest(backupId)` |
| Node re-enroll | re-issue token → cloud-init bootstrap (DR doc §6) |

## Alerting defaults

Notification severity defaults: info→in-app; warning→in-app+email;
critical→in-app+email+push. Per-event overrides and mutes live in
notification preferences (org or user level).

## Escalation flow

See `DISASTER_RECOVERY.md` escalation section; declare an incident first so
audit + notification routing engage together.
