# Prompt 13 — Enterprise, admin, provider health and platform controls

**Recommended Codex reasoning: Extra High**

Continue from Prompt 12.

## Goal

Finish the administrative and enterprise control surfaces required to operate the full platform without source-code edits for normal business changes.

## Admin application

Provide role-protected admin areas for:

### Customers/organizations
- users;
- organizations;
- memberships;
- support notes;
- account status.

### Billing
- plans;
- plan versions;
- entitlements;
- price books;
- regional pricing;
- subscriptions;
- invoices/payment events;
- add-ons;
- manual controlled overrides.

### Compute
- compute providers;
- provider accounts;
- commercial approval state;
- products/SKUs;
- compute classes;
- regions;
- capacity;
- server orders;
- servers;
- upgrades;
- cancellations;
- node health.

### Agents/models
- agents/deployments;
- templates;
- skills;
- runtime versions;
- model providers;
- models;
- system credentials metadata;
- usage.

### Channels/integrations
- providers;
- health;
- connections;
- failed webhooks/jobs.

### Operations
- notifications;
- queues/jobs;
- backups;
- abuse;
- incidents;
- audit;
- costs/margins;
- feature flags;
- system settings.

## Enterprise

Enterprise is not separate code.

Support custom organization contract configuration:
- custom price;
- custom entitlements;
- multiple included nodes;
- custom compute classes;
- team size;
- agent limits;
- private models;
- dedicated database/runtime flags;
- custom retention;
- custom domains;
- audit export;
- SSO/SAML-ready configuration;
- private networking hooks;
- SLA metadata;
- white-label hooks if architecture already supports cleanly.

## Provider health

Build health scoring for compute/model/channel/integration providers:
- API latency;
- failure rate;
- provisioning success/time;
- incident state;
- capacity;
- last successful operation;
- degraded/offline.

Compute auto-selection may use health score only among:
- commercially approved;
- entitlement-compatible;
- region-compatible;
- capacity-available providers.

Never silently switch a customer to a provider that violates configured contract constraints.

## Provider accounts

Support multiple credentials/accounts per provider with:
- region/capacity;
- health;
- usage;
- blast radius;
- rotation;
- disabled state.

## Feature flags

Scoped flags:
- global;
- region;
- plan;
- organization;
- user;
- provider.

Audit changes.
Flags do not replace entitlements.

## Acceptance criteria

- Mox can be commercially operated from admin.
- normal plan/price/provider changes require no deploy.
- enterprise contracts use the same entitlement engine.
- provider health influences safe selection.
- provider accounts are not a single blast-radius dependency.
