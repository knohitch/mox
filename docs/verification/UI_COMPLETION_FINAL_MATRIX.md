# UI Completion Final Matrix

**Starting SHA:** `7b4f8a0b1a2408caffd63f45dda0fa6673001677`  
**Source inspected:** `apps/web/src`, `services/control-plane/src`, `packages/entitlements/src`, `services/admin/src`, Mox runtime/service packages, and Studio fixtures.  
**Classification rule:** every row is classified as product-visible, capability-gated, internal-only, or intentionally blocked. There are zero unclassified rows.

| Capability | Surface | Route/Page | API | Component | Studio Preview | Gate | Runtime Status | Classification |
|---|---|---|---|---|---|---|---|---|
| Workspace dashboard | Customer | `/dashboard` | `listServers`, `listDeployments`, `getUsage`, `listAgents` | `HomeView` | `surface=customer&page=/dashboard` | Customer session | Populated, empty, loading, error states represented | CUSTOMER_VISIBLE |
| Agents roster | Customer | `/agents` | `listAgents`, `getAgent` | `AgentsView` | `surface=customer&page=/agents` | Customer session | Visible and navigable | CUSTOMER_VISIBLE |
| Agent authoring | Customer | `/agents` modal | `createAgentDraft`, `updateAgentDraft`, `publishAgent`, `listAgentVersions`, `rollbackAgent` | `NewAgentModal`, authoring panes | `/agents` | Customer session, plan quotas | Visible; version diff API remains blocked below | CUSTOMER_VISIBLE |
| Agent chat and threads | Customer | `/agents` work pane | `listThreads`, `createThread`, `getMessages`, `send` | `ChatTab` | `/agents` | Customer session | Visible and actionable | CUSTOMER_VISIBLE |
| Agent approvals/events | Customer | `/agents` work pane | `openApprovals`, `resolveApproval`, `getEvents` | `ApprovalsPanel`, `WorkTab` | `/agents` | Customer session | Visible and actionable | CUSTOMER_VISIBLE |
| Computer session | Customer | `/agents` work pane | `computerSnapshot`, local-blocked takeover/restart | `ComputerTab` | `/agents` | `browser_sessions` | Snapshot now calls control-plane 501; takeover/restart blocked until gateway mutation API exists | CUSTOMER_ENTITLEMENT_GATED |
| Workspace files | Customer | `/agents` work pane | `listFiles`, local-blocked `filePreview` | `FilesTab` | `/agents` | `developer_mode` | List now calls control-plane 501; preview blocked until file-content API exists | CUSTOMER_ENTITLEMENT_GATED |
| Runtime terminal | Customer | `/agents` work pane | `runTerminalCommand` | `TerminalTab` | `/agents` | `cli_sessions` | Control-plane fail-closed 501 until configured | CUSTOMER_ENTITLEMENT_GATED |
| Runtime logs | Customer | `/agents` work pane | `getLogs` | `LogsTab` | `/agents` | `developer_mode` | Now calls control-plane 501 until configured | CUSTOMER_ENTITLEMENT_GATED |
| Agent Rooms | Customer | `/rooms` | `listRooms`, `createRoom` | `RoomsView` | `surface=customer&page=/rooms` | `agent_rooms` | Visible with honest unavailable shared-chat state | CUSTOMER_ENTITLEMENT_GATED |
| Deployments | Customer | `/deployments` | `listDeployments`, `deployAgent`, `redeployDeployment`, `deploymentRollback` | `DeploymentsView` | `/deployments` | Customer session | Visible and actionable | CUSTOMER_VISIBLE |
| Servers | Customer | `/servers` | `listServers`, `serverAction` | `ServersView` | `/servers` | Customer session plus server action entitlements | Visible and actionable | CUSTOMER_VISIBLE |
| Models and BYOK | Customer | `/models` | `listModels`, `listModelConnections`, `connectModelConnection`, `rotateModelConnection`, `disconnectModelConnection`, `testProviderConnection` | `ModelsView` | `/models` | `model_connections` | Visible and actionable | CUSTOMER_ENTITLEMENT_GATED |
| Apps and integrations | Customer | `/integrations` | `listIntegrations`, `connectIntegration`, `disconnectIntegration`, `listIntegrationGrants`, `grantIntegrationTool`, `revokeIntegrationGrant` | `IntegrationsView` | `/integrations` | `integrations` | Visible and actionable | CUSTOMER_ENTITLEMENT_GATED |
| Channels | Customer | `/channels` | `listChannels`, `connectChannel`, `reconnectChannel`, `disconnectChannel`, `testChannel` | `ChannelsView` | `/channels` | `channel_connections` | Visible and actionable | CUSTOMER_ENTITLEMENT_GATED |
| Usage | Customer | `/usage` | `getUsage`, `getUsageDetails` | `UsageView` | `/usage` | Customer session | Visible | CUSTOMER_VISIBLE |
| Billing self-service | Customer | `/billing` | `listPlans`, `getSubscription`, `listBillingProviders`, `startCheckout`, `cancelSubscription`, `reconcileCheckout`, `listInvoices`, `getEntitlements` | `BillingView` | `/billing` | Customer session/commercial access | Visible and actionable | CUSTOMER_VISIBLE |
| Backups | Customer | `/backups` | `getBackupsOverview`, `triggerManualBackup`, `testBackupRestore` | `BackupsView` | `/backups` | `backup_retention_days` | Visible and actionable when entitled | CUSTOMER_ENTITLEMENT_GATED |
| Profile and workspace settings | Customer | `/settings` | `me`, `getEntitlements` | `SettingsView` | `/settings` | Customer session | Visible | CUSTOMER_VISIBLE |
| Team management | Customer | `/settings#team` | `getTeamOverview`, `inviteTeamMember`, `revokeTeamInvitation`, `updateTeamMemberRole`, `removeTeamMember` | `SettingsView` | `/settings` | `team_members`, org role rules | Visible and actionable | CUSTOMER_ROLE_GATED |
| Notification preferences | Customer | `/settings#notifications` | `getNotificationPreferences`, `updateNotificationPreferences` | `SettingsView`, `NotificationCenter` | `/settings` | Customer session | Visible and actionable | CUSTOMER_VISIBLE |
| Knowledge sources | Customer | `/settings#knowledge` | `listKnowledgeSources`, `createKnowledgeSource`, `deleteKnowledgeSource` | `SettingsView` | `/settings` | Customer session/storage | Visible and actionable | CUSTOMER_VISIBLE |
| Personal API tokens | Customer | `/settings#developer` | `listApiTokens`, `createApiToken`, `revokeApiToken` | `SettingsView` | `/settings` | Browser/session credential only | Visible and actionable | CUSTOMER_VISIBLE |
| Customer auth | Customer | `/login`, `/signup`, `/forgot-password`, `/reset-password` | `/api/auth/*`, `/api/me` | `AuthPages` | Studio auth link only | Public auth; protected routes redirect | Visible | CUSTOMER_VISIBLE |
| Admin dashboard | Admin | `/admin`, section `dashboard` | `adminOverview` | `AdminView/DashboardPanel` | `surface=admin&page=dashboard` | `admin.read` | Visible to authorized admin roles | ADMIN_CAPABILITY_GATED |
| Admin customers | Admin | `/admin`, section `customers` | `adminCustomers`, `adminCustomerAction`, `adminAddSupportNote` | `CustomersPanel` | `page=customers` | `admin.read`, mutations require `admin.customers.write`/`admin.support.write` | Visible and actionable by capability | ADMIN_CAPABILITY_GATED |
| Admin plans/pricing | Admin | `/admin`, section `plans` | `adminPlans`, `adminUpsertCurrency`, `adminUpsertPriceBook`, `adminSavePlanEntitlement`, `adminSaveAddon` | `PlansPanel` | `page=plans` | `admin.billing.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin payments | Admin | `/admin`, section `payments` | `adminPaymentProviders`, `adminSavePaymentProvider` | `PaymentsPanel` | `page=payments` | `admin.billing.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin compute | Admin | `/admin`, section `compute` | `adminCompute`, `adminSaveComputeAccount`, `adminSaveComputeClass`, `adminComputeOrderAction` | `ComputePanel` | `page=compute` | `admin.compute.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin intelligence | Admin | `/admin`, section `intelligence` | `adminIntelligence`, `adminSaveIntelligenceProvider` | `IntelligencePanel` | `page=intelligence` | `admin.intelligence.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin runtime | Admin | `/admin`, section `runtime` | `adminRuntime`, `adminRuntimeAction` | `RuntimePanel` | `page=runtime` | `admin.operations.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin notifications | Admin | `/admin`, section `notifications` | `adminNotificationJobs`, `adminPreviewNotification`, `adminSendNotification`, `adminScheduleNotification`, `adminCancelNotificationJob`, `adminGetNotificationJob` | `NotificationsPanel` | `page=notifications` | `admin.notifications.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin operations | Admin | `/admin`, section `operations` | `adminOperations`, `adminSaveFeatureFlag`, `adminDeleteFeatureFlag`, `adminRunBackup`, `adminRestoreTest` | `OperationsPanel` | `page=operations` | `admin.read`; mutations require `admin.operations.write` | Visible and actionable by capability | ADMIN_CAPABILITY_GATED |
| Admin enterprise contracts | Admin | `/admin`, section `contracts` | `adminListEnterpriseContracts`, `adminSaveEnterpriseContract`, `adminDeactivateEnterpriseContract` | `ContractsPanel` | `page=contracts` | `admin.billing.write` | Visible and actionable | ADMIN_CAPABILITY_GATED |
| Admin Staff and Access | Admin | `/admin`, section `staff` | `adminStaff`, `adminCreateStaffInvite`, `adminRevokeStaffInvite`, `adminStaffAction` | `StaffPanel` | `page=staff&role=superadmin` | `admin.staff.write` | Superadmin only | ADMIN_CAPABILITY_GATED |
| Admin auth | Admin | `/admin/login`, `/admin/signup`, `/admin/forgot-password`, `/admin/reset-password` | `/api/admin/login`, `/api/admin/session`, `/api/admin/signup` | `AuthPages` | Not a product preview page | Staff cookie/session | Visible | ADMIN_VISIBLE |
| Support overview | Support | `/support`, section `overview` | `supportCustomers` | `SupportConsole` | `surface=support&page=overview` | `support.customer.lookup` | Visible to support manager/agent | SUPPORT_CAPABILITY_GATED |
| Support lookup | Support | `/support`, section `lookup` | `supportCustomers`, `supportCustomer` | `SupportConsole` | `page=lookup` | `support.customer.lookup` | Visible; auto-loads safe summaries | SUPPORT_CAPABILITY_GATED |
| Support diagnostics | Support | `/support`, section `diagnostics` | `supportCustomer` | `SupportConsole` | `page=diagnostics` | `support.customer.lookup` | Visible with safe lifecycle/diagnostics only | SUPPORT_CAPABILITY_GATED |
| Support notes | Support | `/support`, section `notes` | `supportAddNote` | `SupportConsole` | `page=notes` | `support.ticket.write` | Visible and actionable | SUPPORT_CAPABILITY_GATED |
| Support activity | Support | `/support`, section `activity` | `supportCustomer` | `SupportConsole` | `page=activity` | `support.customer.lookup` | Visible safe audit metadata | SUPPORT_CAPABILITY_GATED |
| Support escalations | Support | `/support`, section `escalation` | No mutation API | `SupportConsole` | `page=escalation&role=support_manager` | `support.escalate` | Visible with truthful no-action empty state | NOT_PRODUCTIZED_BLOCKED |
| Support auth | Support | `/support/login`, `/support/signup`, `/support/forgot-password`, `/support/reset-password` | `/api/support/login`, `/api/support/session`, `/api/support/signup` | `AuthPages` | Not a product preview page | Staff cookie/session | Visible | SUPPORT_VISIBLE |
| Studio navigation | Studio | `/__ui` query state | None | `UiStudioView`, `NavAdapterProvider` | All customer/admin/support page catalogs | DEV, opt-in, localhost | Available only under `VITE_MOX_UI_STUDIO` in dev | INTERNAL_ONLY |
| Studio fixtures | Studio | `/__ui` | `createMockMoxStore` only | Fixture factories | populated/empty/loading/error/gated | No cookies, no tokens, no backend calls | Isolated from production composition | INTERNAL_ONLY |
| Demo API | Dev only | none in production | `DemoMoxApi` | Tests/dev only | Not used by Studio store composition | `resolveWebConfig` rejects demo in prod | Not imported by production store | INTERNAL_ONLY |
| Control-plane node enrollment | Runtime | `/node/*` | Not web UI | Runtime node service | Not previewed | Node credentials | Runtime-owned, not product chrome | INTERNAL_ONLY |
| Billing webhooks | Backend | `/webhooks/billing/:provider` | Not web UI | Billing services | Not previewed | Provider signatures/rate limits | Backend-owned | INTERNAL_ONLY |
| Agent version diff | Customer | No UI page | `diffAgentVersions` | none | none | Customer session | API exists; no product caller | NOT_PRODUCTIZED_BLOCKED |
| Thread archive | Customer | No UI control | `archiveThread` | none | none | Customer session | API exists; no product caller | NOT_PRODUCTIZED_BLOCKED |
| CLI engine listing | Customer | No UI section | `listCliEngines` | none | none | Customer session | Endpoint returns fail-closed 501/no tracked state | NOT_PRODUCTIZED_BLOCKED |
| Server order creation route | Backend | `/api/servers/orders` | No current MoxApi method | none | none | Customer session plus entitlement | Covered by admin/server action paths; direct product form not present | NOT_PRODUCTIZED_BLOCKED |
| Computer takeover/restart | Customer | `/agents` work pane | local blocked methods | `ComputerTab` | `/agents` | `browser_sessions` | No control-plane mutation route; UI reports unavailable | NOT_PRODUCTIZED_BLOCKED |
| File preview | Customer | `/agents` work pane | local blocked method | `FilesTab` | `/agents` | `developer_mode` | No control-plane file-content route; UI reports unavailable | NOT_PRODUCTIZED_BLOCKED |

## Staff Role Matrix

| Role | Surface | Visible Sections | Blocked Sections | Classification |
|---|---|---|---|---|
| Superadmin | Admin | dashboard, customers, plans, payments, compute, intelligence, runtime, notifications, operations, contracts, staff | none | ADMIN_CAPABILITY_GATED |
| Billing admin | Admin | dashboard, customers, plans, payments, notifications, operations, contracts | compute, intelligence, runtime, staff | ADMIN_CAPABILITY_GATED |
| Ops admin | Admin | dashboard, customers, compute, intelligence, runtime, notifications, operations | plans, payments, contracts, staff | ADMIN_CAPABILITY_GATED |
| Platform admin | Admin | dashboard, customers, runtime, operations | plans, payments, compute, intelligence, notifications, contracts, staff | ADMIN_CAPABILITY_GATED |
| Support manager | Support | overview, lookup, diagnostics, notes, activity, escalation | admin pages | SUPPORT_CAPABILITY_GATED |
| Support agent | Support | overview, lookup, diagnostics, notes, activity | escalation, admin pages | SUPPORT_CAPABILITY_GATED |

## Entitlement Definitions

The customer-side entitlement vocabulary matches `packages/entitlements/src/index.ts` and `apps/web/src/api/entitlement.ts`: `included_compute_class`, `included_server_count`, `max_agents`, `active_concurrent_agents`, `agent_rooms`, `agents_per_room`, `browser_sessions`, `cli_sessions`, `developer_mode`, `model_connections`, `mox_ai_credits`, `channel_connections`, `integrations`, `storage_gb`, `backup_retention_days`, `team_members`, `voice_minutes`, `schedule_workflow_limit`.
