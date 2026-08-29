# UI Completion Feature-to-Surface Matrix

**Starting SHA:** `e78af1e685ebccde82d1d777ec0da9ed12bd221a`  
**Branch:** `master`  
**Source of truth:** current tree, not prior verification reports.

Classification vocabulary (exactly one per capability):

- `CUSTOMER_VISIBLE`
- `CUSTOMER_ENTITLEMENT_GATED`
- `CUSTOMER_ROLE_GATED`
- `ADMIN_VISIBLE`
- `ADMIN_CAPABILITY_GATED`
- `SUPPORT_VISIBLE`
- `SUPPORT_CAPABILITY_GATED`
- `INTERNAL_ONLY`
- `NOT_PRODUCTIZED_BLOCKED`

There are zero `UNCLASSIFIED` rows.

| Capability | Owner | API | Customer | Admin | Support | Current UI | Current Studio | Gate | Classification | Problem |
|---|---|---|---|---|---|---|---|---|---|---|
| Workspace dashboard | Customer | `listServers`, `listDeployments`, `getUsage`, `listAgents` | `/dashboard` | — | — | `HomeView` | `page=/dashboard` | session | CUSTOMER_VISIBLE | none |
| Agents roster + authoring | Customer | `listAgents`, `createAgentDraft`, `updateAgentDraft`, `publishAgent`, `listAgentVersions`, `rollbackAgent` | `/agents` | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Agent rooms | Customer | `listRooms`, `createRoom` | `/rooms` | — | — | `RoomsView` | `page=/rooms` | entitlement `agent_rooms` | CUSTOMER_ENTITLEMENT_GATED | none |
| Deployments | Customer | `listDeployments`, `deployAgent`, `redeployDeployment`, `deploymentRollback` | `/deployments` | — | — | `DeploymentsView` | `page=/deployments` | session | CUSTOMER_VISIBLE | none |
| Servers | Customer | `listServers`, `serverAction` | `/servers` | — | — | `ServersView` | `page=/servers` | session | CUSTOMER_VISIBLE | none |
| Models + BYOK connections | Customer | `listModels`, `listModelConnections`, `connectModelConnection`, `rotateModelConnection`, `disconnectModelConnection`, `testProviderConnection` | `/models` | — | — | `ModelsView` | `page=/models` | entitlement `model_connections` | CUSTOMER_ENTITLEMENT_GATED | none |
| Apps & integrations | Customer | `listIntegrations`, `connectIntegration`, `disconnectIntegration`, `listIntegrationGrants`, `grantIntegrationTool`, `revokeIntegrationGrant` | `/integrations` | — | — | `IntegrationsView` | `page=/integrations` | entitlement `integrations` | CUSTOMER_ENTITLEMENT_GATED | none |
| Channels | Customer | `listChannels`, `connectChannel`, `reconnectChannel`, `disconnectChannel`, `testChannel` | `/channels` | — | — | `ChannelsView` | `page=/channels` | entitlement `channel_connections` | CUSTOMER_ENTITLEMENT_GATED | none |
| Usage | Customer | `getUsage`, `getUsageDetails` | `/usage` | — | — | `UsageView` | `page=/usage` | session | CUSTOMER_VISIBLE | none |
| Billing | Customer | `listInvoices`, `listPlans`, `getSubscription`, `listBillingProviders`, `startCheckout`, `cancelSubscription`, `reconcileCheckout`, `getEntitlements` | `/billing` | — | — | `BillingView` | `page=/billing` | session | CUSTOMER_VISIBLE | none |
| Backups | Customer | `getBackupsOverview`, `triggerManualBackup`, `testBackupRestore` | `/backups` | — | — | `BackupsView` | `page=/backups` | entitlement `backup_retention_days` | CUSTOMER_ENTITLEMENT_GATED | none |
| Settings: team | Customer | `getTeamOverview`, `inviteTeamMember`, `revokeTeamInvitation`, `updateTeamMemberRole`, `removeTeamMember` | `/settings` | — | — | `SettingsView` | `page=/settings` | entitlement `team_members` + org role | CUSTOMER_ROLE_GATED | none |
| Settings: notification prefs | Customer | `getNotificationPreferences`, `updateNotificationPreferences` | `/settings` | — | — | `SettingsView` | `page=/settings` | session | CUSTOMER_VISIBLE | none |
| Settings: knowledge sources | Customer | `listKnowledgeSources`, `createKnowledgeSource`, `deleteKnowledgeSource` | `/settings` | — | — | `SettingsView` | `page=/settings` | session | CUSTOMER_VISIBLE | none |
| Settings: API tokens | Customer | `listApiTokens`, `createApiToken`, `revokeApiToken` | `/settings` | — | — | `SettingsView` | `page=/settings` | session | CUSTOMER_VISIBLE | none |
| Agent chat / threads | Customer | `listThreads`, `createThread`, `getMessages`, `send` | `/agents` (work pane) | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Approvals | Customer | `openApprovals`, `resolveApproval` | `/agents` | — | — | store + work pane | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Agent events | Customer | `getEvents` | `/agents` | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Voice preview | Customer | `listVoices`, `previewVoice` | `/agents` authoring | — | — | `AgentsView` | `page=/agents` | entitlement `voice` | CUSTOMER_ENTITLEMENT_GATED | none |
| Computer session | Customer | `computerSnapshot`, `computerTakeover`, `computerRestart` | `/agents` work pane | — | — | `AgentsView` | `page=/agents` | entitlement `browser` | CUSTOMER_ENTITLEMENT_GATED | none |
| Workspace files | Customer | `listFiles`, `filePreview` | `/agents` work pane | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Agent terminal | Customer | `runTerminalCommand` | `/agents` work pane | — | — | `AgentsView` | `page=/agents` | entitlement `terminal` | CUSTOMER_ENTITLEMENT_GATED | none |
| Agent logs | Customer | `getLogs` | `/agents` work pane | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| Inbox notifications | Customer | NotificationCenter HTTP (`/api/notifications*`) | shell bell | — | — | `NotificationCenter` | rendered in customer shell | session | CUSTOMER_VISIBLE | none |
| Admin dashboard | Admin | `adminOverview` | — | Dashboard | — | `AdminView` | `page=dashboard` | `admin.read` | ADMIN_VISIBLE | Studio previously supplied `admin.overview.read`; fixed |
| Admin customers | Admin | `adminCustomers`, `adminCustomerAction`, `adminAddSupportNote` | — | Customers | — | `AdminView` | `page=customers` | `admin.read` / `admin.customers.write` | ADMIN_CAPABILITY_GATED | Studio previously used `admin.customers.read`; fixed |
| Admin plans | Admin | `adminPlans`, `adminUpsertCurrency`, `adminUpsertPriceBook`, `adminSavePlanEntitlement`, `adminSaveAddon` | — | Plans | — | `AdminView` | `page=plans` | `admin.billing.write` | ADMIN_CAPABILITY_GATED | Studio previously used `admin.plans.read`; fixed |
| Admin payments | Admin | `adminPaymentProviders`, `adminSavePaymentProvider` | — | Payments | — | `AdminView` | `page=payments` | `admin.billing.write` | ADMIN_CAPABILITY_GATED | none after capability alignment |
| Admin compute | Admin | `adminCompute`, `adminSaveComputeAccount`, `adminSaveComputeClass`, `adminComputeOrderAction` | — | Compute | — | `AdminView` | `page=compute` | `admin.compute.write` | ADMIN_CAPABILITY_GATED | Studio previously used `admin.compute.read`; fixed |
| Admin models / intelligence | Admin | `adminIntelligence`, `adminSaveIntelligenceProvider` | — | Models | — | `AdminView` | `page=intelligence` | `admin.intelligence.write` | ADMIN_CAPABILITY_GATED | Studio previously used `admin.intelligence.read`; fixed |
| Admin runtime | Admin | `adminRuntime`, `adminRuntimeAction` | — | Runtime | — | `AdminView` | `page=runtime` | `admin.operations.write` | ADMIN_CAPABILITY_GATED | Studio previously used `admin.runtime.read`; fixed |
| Admin notifications | Admin | `adminNotificationJobs`, `adminPreviewNotification`, `adminSendNotification`, `adminScheduleNotification`, `adminCancelNotificationJob`, `adminGetNotificationJob` | — | Notifications | — | `AdminView` | `page=notifications` | `admin.notifications.write` | ADMIN_CAPABILITY_GATED | missing from Studio role profiles; fixed |
| Admin operations | Admin | `adminOperations`, `adminSaveFeatureFlag`, `adminDeleteFeatureFlag`, `adminRunBackup`, `adminRestoreTest` | — | Operations | — | `AdminView` | `page=operations` | `admin.read` / `admin.operations.write` | ADMIN_CAPABILITY_GATED | none after capability alignment |
| Admin enterprise contracts | Admin | `adminListEnterpriseContracts`, `adminSaveEnterpriseContract`, `adminDeactivateEnterpriseContract` | — | Contracts | — | `AdminView` | `page=contracts` | `admin.billing.write` | ADMIN_CAPABILITY_GATED | no Studio page selector previously; fixed |
| Admin staff & access | Admin | `adminStaff`, `adminCreateStaffInvite`, `adminRevokeStaffInvite`, `adminStaffAction` | — | Staff & Access | — | `AdminView` | `page=staff` | `admin.staff.write` | ADMIN_CAPABILITY_GATED | Superadmin-only; Studio now grants `*` for that role |
| Support lookup | Support | `supportCustomers`, `supportCustomer` | — | — | Lookup | `SupportConsole` | `page=lookup` | `support.customer.lookup` | SUPPORT_VISIBLE | Populated preview required a manual search; now auto-loads + auto-selects |
| Support diagnostics | Support | `supportCustomer` | — | — | Diagnostics | `SupportConsole` | `page=diagnostics` | `support.customer.lookup` | SUPPORT_VISIBLE | empty until a customer was selected; fixed |
| Support notes | Support | `supportAddNote` | — | — | Notes | `SupportConsole` | `page=notes` | `support.ticket.write` | SUPPORT_CAPABILITY_GATED | none |
| Support activity | Support | `supportCustomer` | — | — | Activity | `SupportConsole` | `page=activity` | `support.customer.lookup` | SUPPORT_VISIBLE | none |
| Support escalation | Support | capability-gated section (no mutation API yet) | — | — | Escalation | `SupportConsole` | `page=escalation` | `support.escalate` | SUPPORT_CAPABILITY_GATED | Studio omitted `support.escalate`; Support Manager now receives it |
| Customer auth | Customer | `/api/auth/*` | `/login` `/signup` `/forgot-password` `/reset-password` | — | — | `AuthPages` | studio chrome link to `/login` only | public | CUSTOMER_VISIBLE | not a Studio product page |
| Admin auth | Admin | `/api/admin/login` `/signup` `/session` | — | `/admin/login`… | — | `AuthPages` | not previewed in this pack | public staff | ADMIN_VISIBLE | out of scope for surface preview |
| Support auth | Support | `/api/support/login` `/signup` `/session` | — | — | `/support/login`… | `AuthPages` | not previewed in this pack | public staff | SUPPORT_VISIBLE | out of scope for surface preview |
| `getAgent` | Customer | `GET /api/agents/:id` | used by roster, not a standalone page | — | — | store / agents | n/a | session | CUSTOMER_VISIBLE | no dedicated page; roster is the entry |
| `updateModel` | Customer | `PATCH /api/agents/:id/model` | agents authoring | — | — | `AgentsView` | `page=/agents` | session | CUSTOMER_VISIBLE | none |
| `diffAgentVersions` | Customer | `GET /api/agents/:id/versions/diff` | — | — | — | none | none | session | NOT_PRODUCTIZED_BLOCKED | no UI caller; versions list + rollback is the productized path |
| `archiveThread` | Customer | `POST /api/threads/:id/archive` | — | — | — | none | none | session | NOT_PRODUCTIZED_BLOCKED | no UI caller; threads remain list/create/send |
| `listCliEngines` | Customer | `GET /api/cli-engines` | — | — | — | none | none | session | NOT_PRODUCTIZED_BLOCKED | no UI caller; BYOK connections are the productized model path |
| Notification HTTP on `HttpMoxApi` (not `MoxApi`) | Customer | `/api/notifications*` | bell | — | — | `NotificationCenter` | customer shell | session | CUSTOMER_VISIBLE | lives beside `MoxApi`, already productized |
| Control-plane provider credentials / DB / runtime internals | Internal | service packages | — | — | — | none | none | staff/server | INTERNAL_ONLY | must not appear in Customer/Admin/Support chrome |
| UI Studio itself | Internal | none (fixtures only) | — | — | — | `/__ui` | DEV + opt-in + localhost | `VITE_MOX_UI_STUDIO` | INTERNAL_ONLY | production 404 |

## Role profiles used by Studio (canonical)

Copied from `services/control-plane/src/config.ts` onto `apps/web/src/concepts/staffNav.ts`:

| Role | Surface | Capabilities |
|---|---|---|
| Superadmin | admin | `*` |
| Platform Admin | admin | `admin.read`, `admin.customers.write`, `admin.support.write`, `admin.operations.write` |
| Billing Admin | admin | `admin.read`, `admin.billing.write`, `admin.notifications.write` |
| Ops Admin | admin | `admin.read`, `admin.compute.write`, `admin.intelligence.write`, `admin.operations.write`, `admin.notifications.write` |
| Support Manager | support | `support.read`, `support.ticket.write`, `support.customer.lookup`, `support.escalate` |
| Support Agent | support | `support.read`, `support.ticket.write`, `support.customer.lookup` |
