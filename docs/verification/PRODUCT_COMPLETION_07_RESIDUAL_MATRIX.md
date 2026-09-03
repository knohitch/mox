# PRODUCT COMPLETION — PHASE 07
# Agent Version Diff + Residual Productization Verification

Starting SHA: `23e055f`

## Summary

Agent version diff is now visible in the Agent Settings tab. The residual productization audit confirms all remaining 501s are legitimate external deployment dependencies — no hidden capabilities, no no-op buttons, no dead routes.

## A. Agent Version Diff UI

**`VersionDiffPanel` component in `AgentsView.tsx`:**
- "Compare" button on each version row in the Versions table
- Revision selector to choose comparison target
- Structured change list from `diffAgentVersions()` API
- Read-only — no mutation, no secret exposure
- Groups changes around canonical AgentDefinition sections (identity, model, instructions, tools, etc.)

**Backend:** `GET /api/agents/:agentId/versions/diff` — already wired, returns structured changes via `diffDefinitions()`.

## B. Residual Productization Audit

### Remaining 501s — All External Deployment Dependencies

| Endpoint | Code | Classification |
|----------|------|----------------|
| Agent turn execution | `mox_runtime_not_configured` | External: requires `MOX_RUNTIME_MODE=full` |
| Credential vault operations | `not_configured` | External: requires `MOX_CUSTOMER_CREDENTIALS_KEY` |
| Channel health probes | `not_configured` | External: requires runtime gateway |
| Computer snapshot/takeover/restart | `not_configured` | External: requires computer provider |
| Workspace file access | `not_configured` | External: requires live node with workspace sync |
| Terminal execution | `not_configured` | External: requires live workload |
| Log streaming | `not_configured` | External: requires live node |

### No-op Audit

| Search Pattern | Results |
|---------------|---------|
| `onClick={() => void 0}` | 0 matches |
| `href="#"` | 0 matches |
| `return []` masking unavailable | 0 matches |
| Hidden tabs/dead routes | 0 matches |
| Backend mutations with no UI | 0 matches |
| UI actions with no backend | 0 matches |

### Phase Closure Verification

| Phase | Feature | Status |
|-------|---------|--------|
| 01 | DEV direct access + admin bootstrap | DONE |
| 02 | Server provisioning | DONE |
| 03 | Room shared conversations | DONE |
| 04 | Computer/Files/Terminal/Logs | DONE |
| 05 | Model probes + CLI state | DONE |
| 06 | Support escalation + staff roles | DONE |
| 07 | Version diff + residual audit | DONE |

## Verification Results

| Gate | Result |
|------|--------|
| `tsc -b --force apps/web` | PASS |
| `pnpm test` | PASS (85 files, 736 tests passed, 107 skipped) |

## Files Modified

- `apps/web/src/views/AgentsView.tsx` — `VersionDiffPanel` component + Compare button
- `md/06_SUPPORT_ESCALATION_AND_STAFF_ROLE_UNIFICATION.md` — marked as done
