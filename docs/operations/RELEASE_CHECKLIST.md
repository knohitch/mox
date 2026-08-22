# Mox Release Checklist

## 1. Quality gates (all must pass)

- [ ] `node scripts/authority-scan.mjs` — no vendored-tree imports
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test` — full matrix per `docs/verification/FULL_SYSTEM_MATRIX.md`
- [ ] `pnpm build`

## 2. Database

- [ ] Migration journal matches `packages/database/migrations` head
      (currently `0000`–`0005`)
- [ ] New migrations applied to a clean database in order (CI job)
- [ ] No destructive migration without a documented rollback in the PR

## 3. Security review for changed surfaces

- [ ] Tenant scoping on any new store query (`orgId` filters)
- [ ] Webhook endpoints: signature verify + dedupe
- [ ] Secrets: vault-only storage; scrubbed logs; no material in rows/bundles
- [ ] SSRF guard applied to any new outbound fetch
- [ ] Admin capabilities mapped to least-privilege roles
- [ ] Threat model updated if new actors/assets introduced

## 4. Provider readiness

- [ ] No provider moved past `verify` without commercial approval record
- [ ] Unconfigured providers still report UNAVAILABLE honestly
- [ ] Health scoring wired for new providers

## 5. Operations readiness

- [ ] Runbook updated for behavior changes
- [ ] Notification templates added for new platform events
- [ ] Feature flags default OFF unless rollout approved
- [ ] DR drill items executed if backup/recovery paths changed

## 6. Post-deploy smoke (staging-safe)

- Checkout with fake gateway → webhook → subscription active
- Order VPS via fake compute provider → running
- Deploy agent revision via node channel → workload applied
- Restore-test latest backup artifact

Real-provider smoke tests run only with explicitly configured credentials.
