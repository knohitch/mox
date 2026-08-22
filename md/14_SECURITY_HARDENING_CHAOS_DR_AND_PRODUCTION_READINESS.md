# Prompt 14 — Security hardening, chaos, disaster recovery and production readiness

**Recommended Codex reasoning: Ultra**

Continue from Prompt 13.

## Goal

Perform a production-grade hardening pass over the complete Mox system. This prompt is not a feature-deletion exercise. Fix security/reliability defects while preserving the full product.

## Threat model

Create/update `docs/security/THREAT_MODEL.md`.

Cover:
- malicious customer with root on their VPS;
- malicious/compromised AI agent;
- prompt injection;
- tool abuse;
- credential theft;
- browser session theft;
- cross-tenant data access;
- SSRF;
- webhook forgery/replay;
- billing fraud;
- provider API credential compromise;
- supply chain;
- Mox Node impersonation;
- compromised customer VPS;
- queue replay/duplication;
- object-storage exposure;
- admin account compromise.

## Authentication/authorization

Review:
- session security;
- MFA/admin hardening;
- tenant authorization;
- role boundaries;
- internal service auth;
- Mox Node enrollment;
- API/CLI tokens;
- webhook verification.

## Secrets

- envelope encryption/key rotation design;
- no secrets in logs;
- no secrets in browser bundle;
- provider-account credentials isolated;
- revoke/rotate flows;
- least privilege.

## Agent/computer containment

Review:
- Docker boundaries;
- browser control ports;
- workspace mounts;
- shell entitlements;
- network egress;
- host Docker socket;
- customer root implications;
- prompt-injection defenses around sensitive tools;
- approval bypass;
- cross-agent browser/profile leakage.

Where stronger sandboxing is required, add a provider-ready path without breaking default Docker deployment.

## Web/SSRF

Harden DSH web fetch/search and Mox integration/webhook systems:
- URL validation;
- metadata/internal-network protections;
- redirects;
- DNS rebinding considerations;
- response size/timeouts.

## Idempotency/reconciliation

Chaos-test:
- duplicated webhooks;
- duplicated jobs;
- lost worker;
- provider timeout after successful VPS order;
- provider API outage;
- Redis restart;
- Mox Node offline;
- runtime crash;
- DB failover/reconnect;
- realtime disconnect.

## Backups/DR

Document and test:
- PostgreSQL backup/restore;
- object storage restore;
- server metadata recovery;
- secret/key recovery assumptions;
- queue loss assumptions;
- rebuild customer node from desired state;
- restore agent/session history.

Create `docs/operations/DISASTER_RECOVERY.md`.

## Observability

Instrument critical paths with OpenTelemetry-compatible traces/metrics/logs:
- checkout/webhook;
- entitlement;
- VPS provisioning;
- node enrollment;
- agent run;
- model call;
- computer action;
- channel webhook;
- integration tool call;
- backup/restore.

## Security test suite

Add/expand:
- tenant isolation;
- secret redaction;
- auth bypass;
- SSRF;
- webhook replay;
- node impersonation;
- policy bypass;
- direct browser service access;
- dangerous shell path;
- admin escalation.

## Acceptance criteria

- threat model is concrete.
- critical isolation/security tests exist.
- disaster recovery is documented and exercised in test/staging-safe form.
- chaos scenarios do not create duplicate VPS/billing side effects.
- observability covers the main transaction paths.
- no known critical security defect remains undocumented.
