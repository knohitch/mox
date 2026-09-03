# PRODUCT COMPLETION — PHASE 04
# Runtime Workspace Surfaces Verification

Starting SHA: `f40b2dd706596a8956c2f418f83182127e77dcb7`

## Summary

Computer, Files, Terminal, and Logs endpoints are now wired to real Mox runtime authority. When runtime is configured, endpoints return truthful state derived from actual deployments and session events. When not configured, they return honest 501. Missing endpoints (takeover, restart, file preview) have been added. HTTP client no longer uses hardcoded throws.

## What Was Built

### Backend — Control Plane Endpoints

| Endpoint | Method | Status |
|----------|--------|--------|
| `/api/computer/:agentId/snapshot` | GET | Wired: checks runtime, returns deployment-derived state or 501 |
| `/api/computer/:agentId/takeover` | POST | **New**: audit-logged takeover/handback, runtime-aware |
| `/api/computer/:agentId/restart` | POST | **New**: audit-logged restart, runtime-aware |
| `/api/agents/:agentId/files` | GET | Wired: runtime-aware, returns honest empty when no live node |
| `/api/agents/:agentId/files/preview` | POST | **New**: path validation, secret blocking, runtime-aware |
| `/api/agents/:agentId/terminal` | POST | Wired: runtime-aware, honest acknowledgment without live workload |
| `/api/agents/:agentId/logs` | GET | Wired: returns session events as truthful log source when runtime configured |

### Security — File Path Validation

`validateFilePath()` blocks:
- `..` traversal
- Absolute paths (`/` or `C:\`)
- Secret/credential files (`.env`, `credentials`, `secret`, `token`, `.ssh/`, `.aws/`, `.gcp/`)

### HTTP Client

- `computerTakeover()`: Now calls `POST /api/computer/:agentId/takeover` (was hardcoded throw)
- `computerRestart()`: Now calls `POST /api/computer/:agentId/restart` (was hardcoded throw)
- `filePreview()`: Now calls `POST /api/agents/:agentId/files/preview` (was hardcoded throw)

### Room Thread Fix (Phase 03 residual)

- Fixed `agents.name` → `agents.displayName` in room message agent name resolution
- Fixed `firstAgent.agentId` type narrowing in `ensureRoomThread`

## Verification Results

| Gate | Result |
|------|--------|
| `tsc -b --force apps/web` | PASS |
| `tsc -b --force services/control-plane` | PASS |
| `pnpm test` | PASS (85 files, 736 tests passed, 107 skipped) |

## Code Completion vs External Deployment

| Capability | Code Status | External Dependency |
|-----------|-------------|-------------------|
| Computer snapshot | Complete | Requires computer provider (Playwright/etc) |
| Computer takeover | Complete | Requires computer provider |
| Computer restart | Complete | Requires computer provider |
| File listing | Complete | Requires live node with workspace sync |
| File preview | Complete | Requires live node with workspace sync |
| Terminal execution | Complete | Requires live workload/container |
| Log streaming | Complete | Falls back to session events when no live node |

## Files Modified

- `services/control-plane/src/api.ts` — wired endpoints, added takeover/restart/file-preview, file path validation, room thread fixes
- `apps/web/src/api/http-api.ts` — replaced hardcoded throws with real endpoint calls
- `md/03_AGENT_ROOMS_SHARED_CONVERSATION.md` — marked as done
