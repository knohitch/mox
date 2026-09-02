import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useMox } from "../api/store.js";
import type {
  AdminCompute,
  AdminCustomer,
  AdminEnterpriseContract,
  AdminFeatureFlag,
  AdminIntelligence,
  AdminNotificationJobDetails,
  AdminNotificationJobs,
  AdminOperations,
  AdminOverview,
  AdminPaymentProvider,
  AdminPlans,
  AdminRuntimeAgent,
  AdminStaff,
  CreatedStaffInvite,
} from "../api/types.js";
import { Badge, Card, DataTable, EmptyState } from "../ui/primitives.js";
import { ADMIN_TAB_LABEL, canManageStaff, hasSurfaceCapability, isAdminTabKey, visibleAdminTabs } from "../concepts/staffNav.js";
import { useStaffSection } from "../shell/staffSection.js";
import { formatDisplayValue, humanizeLabel } from "../domain/labels.js";


type AdminTab = "dashboard" | "customers" | "plans" | "payments" | "compute" | "intelligence" | "runtime" | "notifications" | "operations" | "contracts" | "staff";

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function money(minor: string | number | undefined, currency = "USD"): string {
  const amount = Number(minor ?? 0) / 100;
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function toneFor(value: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  const v = value.toLowerCase();
  if (["active", "running", "healthy", "completed", "current", "enabled", "available", "provisioned", "online", "live"].some((x) => v.includes(x))) return "good";
  if (["pending", "scheduled", "maintenance", "trial", "grace", "degraded", "busy", "working", "stopping"].some((x) => v.includes(x))) return "warn";
  if (["failed", "error", "denied", "suspended", "canceled", "not_configured", "stopped", "offline", "unavailable"].some((x) => v.includes(x))) return "bad";
  return "neutral";
}

function renderAdminCell(column: string, val: unknown): ReactNode {
  const str = formatDisplayValue(val);
  if (!str) return "";
  const lower = str.toLowerCase();
  const stateColumns = ["state", "status", "lifecycle", "nodehealth", "runtimehealth", "deliverystate", "deploymentstate", "health"];
  const stateKeywords = ["running", "active", "healthy", "idle", "provisioned", "online", "live", "degraded", "pending", "working", "failed", "error", "stopped", "unavailable", "offline", "suspended", "enabled", "disabled"];
  if (stateColumns.includes(column.toLowerCase()) || stateKeywords.includes(lower)) {
    return <Badge tone={toneFor(str)}>{str}</Badge>;
  }
  return str;
}

function AdminDataTable({ columns, rows, empty = "No records." }: { columns: string[]; rows: Array<Record<string, unknown>>; empty?: string }) {
  const head = columns.map((c) => ({ key: c, label: humanizeLabel(c), render: (row: any) => renderAdminCell(c, row[c]) }));
  return <DataTable head={head} rows={rows} empty={empty} />;
}

function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function AdminView() {
  const { api, staffSession } = useMox();
  const capabilities = staffSession?.capabilities ?? [];
  const visibleTabs = visibleAdminTabs(capabilities);
  const { section: staffSection, setSection: setStaffSection } = useStaffSection();
  const tab: AdminTab = isAdminTabKey(staffSection) ? staffSection : "dashboard";
  const setTab = (next: AdminTab) => setStaffSection?.(next);
  useEffect(() => {
    // Prompt 03: never leave a capability-gated tab active after the visible
    // set changes (e.g. a reduced-role staff member lands on a hidden tab).
    if (!visibleTabs.includes(tab)) {
      setTab(visibleTabs[0] ?? "dashboard");
    }
  }, [visibleTabs, tab]);
  const [overview, setOverview] = useState<AdminOverview>();
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [plans, setPlans] = useState<AdminPlans>();
  const [payments, setPayments] = useState<AdminPaymentProvider[]>([]);
  const [compute, setCompute] = useState<AdminCompute>();
  const [intelligence, setIntelligence] = useState<AdminIntelligence>();
  const [runtime, setRuntime] = useState<AdminRuntimeAgent[]>([]);
  const [operations, setOperations] = useState<AdminOperations>();
  const [notificationJobs, setNotificationJobs] = useState<AdminNotificationJobs>();
  const [enterpriseContracts, setEnterpriseContracts] = useState<AdminEnterpriseContract[]>([]);
  const [staff, setStaff] = useState<AdminStaff>();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const results = await Promise.allSettled([
        api.adminOverview(),
        api.adminCustomers(),
        api.adminPlans(),
        api.adminPaymentProviders(),
        api.adminCompute(),
        api.adminIntelligence(),
        api.adminRuntime(),
        api.adminOperations(),
        api.adminNotificationJobs(),
        canManageStaff(capabilities) ? api.adminStaff() : Promise.resolve(undefined),
        hasSurfaceCapability(capabilities, "admin.billing.write") ? api.adminListEnterpriseContracts() : Promise.resolve([]),
      ]);
      const [o, c, p, pay, comp, intel, run, ops, jobs, staffRes, contractsRes] = results;
      if (o.status === "fulfilled") setOverview(o.value);
      if (c.status === "fulfilled") setCustomers(c.value);
      if (p.status === "fulfilled") setPlans(p.value);
      if (pay.status === "fulfilled") setPayments(pay.value);
      if (comp.status === "fulfilled") setCompute(comp.value);
      if (intel.status === "fulfilled") setIntelligence(intel.value);
      if (run.status === "fulfilled") setRuntime(run.value);
      if (ops.status === "fulfilled") setOperations(ops.value);
      if (jobs.status === "fulfilled") setNotificationJobs(jobs.value);
      if (staffRes.status === "fulfilled" && staffRes.value) setStaff(staffRes.value);
      if (contractsRes.status === "fulfilled") setEnterpriseContracts(contractsRes.value as AdminEnterpriseContract[]);
      const firstError = results.find((r) => r.status === "rejected");
      if (firstError && firstError.status === "rejected") {
        setStatus(firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const content = {
    dashboard: <DashboardPanel overview={overview} />,
    customers: <CustomersPanel customers={customers} onRefresh={refresh} />,
    plans: <PlansPanel plans={plans} onRefresh={refresh} />,
    payments: <PaymentsPanel payments={payments} onRefresh={refresh} />,
    compute: <ComputePanel compute={compute} onRefresh={refresh} />,
    intelligence: <IntelligencePanel intelligence={intelligence} onRefresh={refresh} />,
    runtime: <RuntimePanel runtime={runtime} onRefresh={refresh} />,
    notifications: <NotificationsPanel jobs={notificationJobs} onRefresh={refresh} />,
    operations: <OperationsPanel operations={operations} onRefresh={refresh} />,
    contracts: <ContractsPanel contracts={enterpriseContracts} onRefresh={refresh} />,
    staff: <StaffPanel staff={staff} onRefresh={refresh} />,
  }[tab];

  if (visibleTabs.length === 0) {
    return (
      <div className="admin-console">
        <div className="admin-alert" role="alert">This account has no platform-admin capability on this surface.</div>
      </div>
    );
  }

  return (
    <div className="admin-console">
      <header className="admin-page-head">
        <div>
          <div className="admin-kicker">Mox Admin</div>
          <h1>{ADMIN_TAB_LABEL[tab]}</h1>
          <p className="page-sub">Platform operations for the role on this session. Secrets stay off this surface.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "Refreshing" : "Refresh"}
        </button>
      </header>
      {status ? <div className="admin-alert" role="alert">{status}</div> : null}
      {content}
    </div>
  );
}

function StaffPanel({ staff, onRefresh }: { staff?: AdminStaff; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [invite, setInvite] = useState({ email: "", role: "platform_admin", surface: "admin" as "admin" | "support" | "both" });
  const [created, setCreated] = useState<CreatedStaffInvite | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!staff) return <EmptyState>Loading Staff &amp; Access.</EmptyState>;
  return (
    <>
      <div className="grid grid-2">
        <Card title={`Platform staff (${staff.members.length})`}>
          <DataTable
            head={[
              { key: "displayName", label: "Display name" },
              { key: "email", label: "Email" },
              { key: "role", label: "Role" },
              { key: "surface", label: "Surface" },
              { key: "status", label: "Status", render: (member) => member.revokedAt ? "revoked" : member.enabled ? "active" : "disabled" },
              { key: "createdAt", label: "Granted at" },
              { key: "actions", label: "", render: (member) => (
                <div className="admin-actions-cell">
                  {!member.revokedAt && !member.enabled && (
                    <button type="button" onClick={() => void confirmAnd(async () => {
                      await api.adminStaffAction(member.userId, member.role, "enable");
                      await onRefresh();
                    })}>Enable</button>
                  )}
                  {!member.revokedAt && member.enabled && (
                    <>
                      <button type="button" className="danger" onClick={() => void confirmAnd(async () => {
                        await api.adminStaffAction(member.userId, member.role, "disable", "admin_console");
                        await onRefresh();
                      })}>Disable</button>
                      <button type="button" className="danger" onClick={() => void confirmAnd(async () => {
                        await api.adminStaffAction(member.userId, member.role, "revoke", "admin_console");
                        await onRefresh();
                      })}>Revoke</button>
                    </>
                  )}
                </div>
              )}
            ]}
            rows={staff.members}
          />
        </Card>
        <div>
          <Card title="Invite staff">
            <form className="admin-form" onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                setBusy(true);
                setStatus(null);
                try {
                  setCreated(await api.adminCreateStaffInvite(invite));
                  setInvite({ email: "", role: "platform_admin", surface: "admin" });
                  await onRefresh();
                } catch (error) {
                  setStatus(error instanceof Error ? error.message : String(error));
                } finally {
                  setBusy(false);
                }
              })();
            }}>
              <input value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} placeholder="Staff email" required />
              <select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value })}>
                <option value="platform_admin">Platform admin</option>
                <option value="support_manager">Support manager</option>
                <option value="support_agent">Support agent</option>
              </select>
              <select value={invite.surface} onChange={(event) => setInvite({ ...invite, surface: event.target.value as "admin" | "support" | "both" })}>
                <option value="admin">Admin</option>
                <option value="support">Support</option>
                <option value="both">Both</option>
              </select>
              <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create invite"}</button>
            </form>
            {status ? <div className="admin-alert" role="alert">{status}</div> : null}
            {created ? (
              <div className="admin-secret-state" role="status">
                <strong>Invite created — share the one-time token (shown only once):</strong>
                <code className="invite-token">{created.token}</code>
                <div className="muted">Pending: {created.email} · {created.role} · {created.surface}</div>
              </div>
            ) : null}
          </Card>
          <Card title={`Pending invites (${staff.invites.length})`}>
            <DataTable
              head={[
                { key: "email", label: "Email" },
                { key: "role", label: "Role" },
                { key: "surface", label: "Surface" },
                { key: "expiresAt", label: "Expires" },
                { key: "status", label: "Status", render: (inviteRow) => inviteRow.revokedAt ? "revoked" : inviteRow.consumedAt ? "consumed" : "pending" },
                { key: "actions", label: "", render: (inviteRow) => (
                  <div className="admin-actions-cell">
                    {!inviteRow.revokedAt && !inviteRow.consumedAt && (
                      <button type="button" className="danger" onClick={() => void confirmAnd(async () => {
                        await api.adminRevokeStaffInvite(inviteRow.invitationId);
                        await onRefresh();
                      })}>Revoke</button>
                    )}
                  </div>
                )}
              ]}
              rows={staff.invites}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

/** Confirmation before privileged staff-management mutations. */
function confirmAnd(action: () => Promise<void>): Promise<void> {
  return window.confirm("Confirm this privileged staff action?") ? action() : Promise.resolve();
}

function DashboardPanel({ overview }: { overview?: AdminOverview }) {
  if (!overview) return <EmptyState title="Loading dashboard">Fetching authorized platform metrics.</EmptyState>;
  const m = overview.metrics;
  const healthyAgents = m.runtimeAgentHealth.total - m.runtimeAgentHealth.degraded;
  return (
    <>
      <div className="needs-attention-grid" aria-label="Needs attention">
        <div className="needs-chip"><strong>{m.paymentFailures}</strong><span>Payment failures</span></div>
        <div className="needs-chip"><strong>{m.serverProvisioningFailures}</strong><span>Provisioning failures</span></div>
        <div className="needs-chip"><strong>{m.runtimeAgentHealth.degraded}</strong><span>Degraded runtime agents</span></div>
        <div className="needs-chip"><strong>{m.providerIncidents}</strong><span>Provider incidents</span></div>
      </div>
      <div className="admin-metrics">
        <Metric label="Customers" value={m.customers} />
        <Metric label="Active subscriptions" value={m.activeSubscriptions} />
        <Metric label="Active servers" value={m.activeServers} />
        <Metric label="Runtime health" value={`${healthyAgents}/${m.runtimeAgentHealth.total}`} detail="agents healthy" />
        <Metric label="Notification jobs" value={m.notifications} />
        <Metric label="Abuse reports" value={m.abuse} />
        {m.costMargin ? <Metric label="Recorded revenue" value={money(Number(m.costMargin.revenueMinor), m.costMargin.currency)} /> : null}
      </div>
      <div className="grid grid-3">
        <Card title="Provider incidents">
          <AdminDataTable columns={["incidentId", "kind", "severity", "status", "title"]} rows={overview.incidents} />
        </Card>
        <Card title="Recent notification jobs">
          <AdminDataTable columns={["id", "audienceType", "status", "fanoutDone", "fanoutTotal"]} rows={overview.notifications} />
        </Card>
        <Card title="Open abuse">
          <AdminDataTable columns={["id", "orgId", "category", "severity", "status"]} rows={overview.abuse} />
        </Card>
      </div>
    </>
  );
}

function CustomersPanel({ customers, onRefresh }: { customers: AdminCustomer[]; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [selectedId, setSelectedId] = useState<string | null>(customers[0]?.orgId ?? null);
  const [note, setNote] = useState("");
  const [suspendReason, setSuspendReason] = useState("admin_controlled");
  const [financialReconciled, setFinancialReconciled] = useState(false);
  const selected = customers.find((customer) => customer.orgId === selectedId) ?? customers[0];
  useEffect(() => {
    if (!selectedId && customers[0]) setSelectedId(customers[0].orgId);
  }, [customers, selectedId]);
  return (
    <div className="admin-split">
      <Card title={`Organizations (${customers.length})`}>
        {customers.map((customer) => (
          <button key={customer.orgId} type="button" className={`admin-list-item ${selected?.orgId === customer.orgId ? "active" : ""}`} onClick={() => setSelectedId(customer.orgId)}>
            <strong>{customer.displayName}</strong>
            <span>{customer.users.length} users · {customer.subscriptions.length} subscriptions · {customer.servers.length} servers</span>
          </button>
        ))}
      </Card>
      <section>
        {!selected ? <EmptyState>No organizations found.</EmptyState> : (
          <>
            <Card title={selected.displayName} actions={<Badge tone="accent">{selected.slug}</Badge>}>
              <div className="admin-action-row" style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <select value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)}>
                  <option value="admin_controlled">Admin Controlled</option>
                  <option value="billing_nonpayment">Billing Non-payment</option>
                  <option value="abuse_investigation">Abuse Investigation</option>
                  <option value="security_containment">Security Containment</option>
                </select>
                <button type="button" className="danger" onClick={() => void api.adminCustomerAction(selected.orgId, "suspend", suspendReason).then(onRefresh)}>Suspend</button>
                <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <input type="checkbox" checked={financialReconciled} onChange={(e) => setFinancialReconciled(e.target.checked)} />
                  Financial Reconciled
                </label>
                <button type="button" onClick={() => void api.adminCustomerAction(selected.orgId, "reactivate").then(onRefresh)}>Reactivate</button>
              </div>
              <AdminDataTable columns={["email", "displayName", "role", "disabledAt"]} rows={selected.users} />
            </Card>
            <Card title="Subscriptions, servers and agents">
              <AdminDataTable columns={["id", "plan", "tier", "state", "failedRenewals"]} rows={selected.subscriptions} />
              <AdminDataTable columns={["id", "hostname", "providerName", "regionCode", "state", "lastError"]} rows={selected.servers} />
              <AdminDataTable columns={["agentId", "displayName", "status", "currentVersion"]} rows={selected.agents} />
            </Card>
            <Card title="Support notes">
              <form className="admin-inline-form" onSubmit={(event) => {
                event.preventDefault();
                if (!note.trim()) return;
                void api.adminAddSupportNote(selected.orgId, note).then(() => {
                  setNote("");
                  return onRefresh();
                });
              }}>
                <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a support note" />
                <button type="submit">Add note</button>
              </form>
              <AdminDataTable columns={["at", "actorId", "note"]} rows={selected.supportNotes} />
            </Card>
          </>
        )}
      </section>
    </div>
  );
}

function PlansPanel({ plans, onRefresh }: { plans?: AdminPlans; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [currencyCode, setCurrencyCode] = useState("NGN");
  const [currencyName, setCurrencyName] = useState("Nigerian naira");
  const [exponent, setExponent] = useState(2);
  const [priceDraft, setPriceDraft] = useState({ productId: "", pricingRegion: "GLOBAL", mode: "fixed", amountMinor: "", currency: "USD" });
  const [addonDraft, setAddonDraft] = useState({ code: "", displayName: "", consumable: false, unit: "unit" });
  const [entDraft, setEntDraft] = useState({ planVersionId: "", key: "", value: "" });

  if (!plans) return <EmptyState>Loading plan catalog.</EmptyState>;
  return (
    <>
      <div className="grid grid-2">
        <Card title="Plan versions">
          <AdminDataTable columns={["id", "productId", "version", "status", "activatedAt"]} rows={plans.planVersions} />
        </Card>
        <Card title="Entitlement Definitions">
          <AdminDataTable columns={["key", "valueType", "description", "defaultValue"]} rows={plans.entitlementDefinitions} />
        </Card>
      </div>

      <Card title="Plan Entitlement Values">
        <AdminDataTable columns={["planVersionId", "key", "value"]} rows={plans.entitlementValues} />
        <form className="admin-inline-form" onSubmit={(e) => {
          e.preventDefault();
          if (!entDraft.planVersionId || !entDraft.key) return;
          let parsed: boolean | number | string = entDraft.value;
          if (parsed === "true") parsed = true;
          else if (parsed === "false") parsed = false;
          else if (!isNaN(Number(parsed)) && parsed.trim() !== "") parsed = Number(parsed);
          void api.adminSavePlanEntitlement(entDraft.planVersionId, entDraft.key, parsed).then(onRefresh);
        }}>
          <select value={entDraft.planVersionId} onChange={(e) => setEntDraft({ ...entDraft, planVersionId: e.target.value })} required>
            <option value="">Select Plan Version</option>
            {plans.planVersions.map((pv) => <option key={asString(pv.id)} value={asString(pv.id)}>{asString(pv.id).slice(0, 8)} ({asString(pv.status)})</option>)}
          </select>
          <select value={entDraft.key} onChange={(e) => setEntDraft({ ...entDraft, key: e.target.value })} required>
            <option value="">Select Entitlement Key</option>
            {plans.entitlementDefinitions.map((ed) => <option key={asString(ed.key)} value={asString(ed.key)}>{asString(ed.key)}</option>)}
          </select>
          <input value={entDraft.value} onChange={(e) => setEntDraft({ ...entDraft, value: e.target.value })} placeholder="Value" required />
          <button type="submit">Update entitlement</button>
        </form>
      </Card>

      <Card title="Regional price books">
        <AdminDataTable columns={["id", "productId", "pricingRegion", "mode", "baseCurrency", "baseAmountMinor", "fxRateScaled"]} rows={plans.priceBooks} />
        <form className="admin-inline-form" onSubmit={(event) => {
          event.preventDefault();
          void api.adminUpsertPriceBook(priceDraft).then(onRefresh);
        }}>
          <select value={priceDraft.productId} onChange={(event) => setPriceDraft({ ...priceDraft, productId: event.target.value })} required>
            <option value="">Plan</option>
            {plans.products.map((product) => <option key={asString(product.id)} value={asString(product.id)}>{asString(product.displayName)}</option>)}
          </select>
          <input value={priceDraft.pricingRegion} onChange={(event) => setPriceDraft({ ...priceDraft, pricingRegion: event.target.value })} placeholder="Region" />
          <select value={priceDraft.mode} onChange={(event) => setPriceDraft({ ...priceDraft, mode: event.target.value })}>
            <option value="fixed">Fixed</option>
            <option value="fx_derived">FX-derived</option>
            <option value="disabled">Disabled</option>
          </select>
          <input value={priceDraft.amountMinor} onChange={(event) => setPriceDraft({ ...priceDraft, amountMinor: event.target.value })} placeholder="Amount minor" />
          <input value={priceDraft.currency} onChange={(event) => setPriceDraft({ ...priceDraft, currency: event.target.value.toUpperCase() })} placeholder="Currency" />
          <button type="submit">Save price book</button>
        </form>
      </Card>

      <div className="grid grid-2">
        <Card title="Price Versions & Effective Dates">
          <AdminDataTable columns={["priceBookId", "version", "amountMinor", "currency", "effectiveFrom"]} rows={plans.priceVersions} />
        </Card>
        <Card title="Pricing Regions">
          <AdminDataTable columns={["code", "name", "defaultCurrency"]} rows={plans.pricingRegions} />
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Currencies">
          <form className="admin-inline-form" onSubmit={(event) => {
            event.preventDefault();
            void api.adminUpsertCurrency({ code: currencyCode, displayName: currencyName, exponent }).then(onRefresh);
          }}>
            <input value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} />
            <input value={currencyName} onChange={(event) => setCurrencyName(event.target.value)} />
            <input type="number" value={exponent} onChange={(event) => setExponent(Number(event.target.value))} />
            <button type="submit">Save currency</button>
          </form>
          <AdminDataTable columns={["code", "displayName", "exponent"]} rows={plans.currencies} />
        </Card>
        <Card title="Add-ons">
          <AdminDataTable columns={["code", "displayName", "consumable", "unit"]} rows={plans.addons} />
          <form className="admin-inline-form" onSubmit={(e) => {
            e.preventDefault();
            if (!addonDraft.code || !addonDraft.displayName) return;
            void api.adminSaveAddon(addonDraft).then(() => {
              setAddonDraft({ code: "", displayName: "", consumable: false, unit: "unit" });
              return onRefresh();
            });
          }}>
            <input value={addonDraft.code} onChange={(e) => setAddonDraft({ ...addonDraft, code: e.target.value })} placeholder="Code" required />
            <input value={addonDraft.displayName} onChange={(e) => setAddonDraft({ ...addonDraft, displayName: e.target.value })} placeholder="Display Name" required />
            <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <input type="checkbox" checked={addonDraft.consumable} onChange={(e) => setAddonDraft({ ...addonDraft, consumable: e.target.checked })} /> Consumable
            </label>
            <input value={addonDraft.unit} onChange={(e) => setAddonDraft({ ...addonDraft, unit: e.target.value })} placeholder="Unit" />
            <button type="submit">Save add-on</button>
          </form>
        </Card>
      </div>
    </>
  );
}

function PaymentsPanel({ payments, onRefresh }: { payments: AdminPaymentProvider[]; onRefresh: () => Promise<void> }) {
  return (
    <div className="grid grid-2">
      {payments.map((provider) => (
        <PaymentProviderCard key={provider.providerName} provider={provider} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function PaymentProviderCard({ provider, onRefresh }: { provider: AdminPaymentProvider; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [draft, setDraft] = useState({
    displayName: provider.displayName,
    enabled: provider.enabled,
    environment: provider.environment,
    publicConfig: JSON.stringify(provider.publicConfig ?? {}, null, 2),
    secretRef: "",
    webhookSecretRef: "",
    supportedCurrencies: provider.supportedCurrencies.join(","),
    supportedRegions: provider.supportedRegions.join(","),
    maintenanceMode: provider.maintenanceMode,
  });
  return (
    <Card title={provider.displayName || provider.providerName} actions={<Badge tone={toneFor(provider.health)}>{provider.health}</Badge>}>
      <div className="admin-secret-state">
        API secret: {provider.hasSecretRef ? "configured" : "not configured"} · Webhook: {provider.webhookStatus} · Reconciliation: {provider.reconciliationStatus}
      </div>
      <form className="admin-form" onSubmit={(event) => {
        event.preventDefault();
        void api.adminSavePaymentProvider(provider.providerName, {
          displayName: draft.displayName,
          enabled: draft.enabled,
          environment: draft.environment,
          publicConfig: JSON.parse(draft.publicConfig || "{}"),
          secretRef: draft.secretRef || undefined,
          webhookSecretRef: draft.webhookSecretRef || undefined,
          supportedCurrencies: draft.supportedCurrencies.split(",").map((x) => x.trim()).filter(Boolean),
          supportedRegions: draft.supportedRegions.split(",").map((x) => x.trim()).filter(Boolean),
          maintenanceMode: draft.maintenanceMode,
        }).then(onRefresh);
      }}>
        <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
        <select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value })}>
          <option value="test">Test</option>
          <option value="live">Live</option>
        </select>
        <label className="admin-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
        <label className="admin-check"><input type="checkbox" checked={draft.maintenanceMode} onChange={(event) => setDraft({ ...draft, maintenanceMode: event.target.checked })} /> Maintenance</label>
        <input value={draft.secretRef} onChange={(event) => setDraft({ ...draft, secretRef: event.target.value })} placeholder="Mox Vault API secret ref" />
        <input value={draft.webhookSecretRef} onChange={(event) => setDraft({ ...draft, webhookSecretRef: event.target.value })} placeholder="Mox Vault webhook secret ref" />
        <input value={draft.supportedCurrencies} onChange={(event) => setDraft({ ...draft, supportedCurrencies: event.target.value })} placeholder="USD,GBP,NGN,GHS" />
        <input value={draft.supportedRegions} onChange={(event) => setDraft({ ...draft, supportedRegions: event.target.value })} placeholder="GLOBAL,NG,GH,GB" />
        <textarea value={draft.publicConfig} onChange={(event) => setDraft({ ...draft, publicConfig: event.target.value })} />
        <button type="submit">Save provider</button>
      </form>
    </Card>
  );
}

function ComputePanel({ compute, onRefresh }: { compute?: AdminCompute; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [account, setAccount] = useState({ providerName: "contabo", accountLabel: "primary", regionCode: "", commercialStatus: "pending", credentialRefId: "" });
  const [cls, setCls] = useState({ code: "MOX_SMALL", displayName: "Mox Small", minVcpu: 2, minRamGb: 4, skuMap: "[]" });
  if (!compute) return <EmptyState>Loading compute.</EmptyState>;
  return (
    <>
      <div className="grid grid-2">
        <Card title="Provider accounts">
          <form className="admin-inline-form" onSubmit={(event) => {
            event.preventDefault();
            void api.adminSaveComputeAccount(account.providerName, account.accountLabel, account).then(onRefresh);
          }}>
            <select value={account.providerName} onChange={(event) => setAccount({ ...account, providerName: event.target.value })}>
              {compute.providers.map((provider) => <option key={provider}>{provider}</option>)}
            </select>
            <input value={account.accountLabel} onChange={(event) => setAccount({ ...account, accountLabel: event.target.value })} />
            <input value={account.regionCode} onChange={(event) => setAccount({ ...account, regionCode: event.target.value })} placeholder="Region" />
            <input value={account.commercialStatus} onChange={(event) => setAccount({ ...account, commercialStatus: event.target.value })} placeholder="Approval state" />
            <input value={account.credentialRefId} onChange={(event) => setAccount({ ...account, credentialRefId: event.target.value })} placeholder="Credential ref id" />
            <button type="submit">Save account</button>
          </form>
          <AdminDataTable columns={["providerName", "accountLabel", "regionCode", "commercialStatus", "healthScore", "enabled", "hasCredentialRef"]} rows={compute.accounts} />
        </Card>
        <Card title="Compute classes">
          <form className="admin-inline-form" onSubmit={(event) => {
            event.preventDefault();
            void api.adminSaveComputeClass(cls.code, { ...cls, skuMap: JSON.parse(cls.skuMap) }).then(onRefresh);
          }}>
            <input value={cls.code} onChange={(event) => setCls({ ...cls, code: event.target.value.toUpperCase() })} />
            <input value={cls.displayName} onChange={(event) => setCls({ ...cls, displayName: event.target.value })} />
            <input type="number" value={cls.minVcpu} onChange={(event) => setCls({ ...cls, minVcpu: Number(event.target.value) })} />
            <input type="number" value={cls.minRamGb} onChange={(event) => setCls({ ...cls, minRamGb: Number(event.target.value) })} />
            <input value={cls.skuMap} onChange={(event) => setCls({ ...cls, skuMap: event.target.value })} />
            <button type="submit">Save class</button>
          </form>
          <AdminDataTable columns={["code", "displayName", "minVcpu", "minRamGb", "active"]} rows={compute.classes} />
        </Card>
      </div>
      <Card title="Orders and lifecycle">
        <DataTable
          head={[
            { key: "id", label: "ID", render: (order) => <code>{asString(order.id).slice(0, 8)}</code> },
            { key: "orgId", label: "Org", render: (order) => <code>{asString(order.orgId).slice(0, 8)}</code> },
            { key: "hostname", label: "Hostname", render: (order) => asString(order.hostname) },
            { key: "providerName", label: "Provider", render: (order) => asString(order.providerName) },
            { key: "regionCode", label: "Region", render: (order) => asString(order.regionCode) },
            { key: "providerSku", label: "SKU", render: (order) => asString(order.providerSku) },
            { key: "state", label: "State", render: (order) => <Badge tone={toneFor(asString(order.state))}>{asString(order.state)}</Badge> },
            { key: "lastError", label: "Error", render: (order) => asString(order.lastError) },
            { key: "actions", label: "Actions", render: (order) => (
              <div className="admin-actions-cell" style={{ display: "flex", gap: "6px" }}>
                <button type="button" onClick={() => void api.adminComputeOrderAction(asString(order.id), "restart").then(onRefresh)}>Restart</button>
                <button type="button" onClick={() => void api.adminComputeOrderAction(asString(order.id), "redeploy").then(onRefresh)}>Redeploy</button>
                <button type="button" className="danger" onClick={() => void api.adminComputeOrderAction(asString(order.id), "cancel").then(onRefresh)}>Cancel</button>
              </div>
            )}
          ]}
          rows={compute.orders}
          empty="No compute orders."
        />
      </Card>
      <Card title="Mox Node health">
        <AdminDataTable columns={["nodeId", "orgId", "orderId", "version", "status", "lastHeartbeatAt"]} rows={compute.nodes} />
      </Card>
    </>
  );
}

function IntelligencePanel({ intelligence, onRefresh }: { intelligence?: AdminIntelligence; onRefresh: () => Promise<void> }) {
  if (!intelligence) return <EmptyState>Loading Models and Intelligence.</EmptyState>;
  return (
    <div className="grid grid-2">
      {intelligence.providers.map((provider) => (
        <IntelligenceProviderCard key={provider.slug} provider={provider} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function IntelligenceProviderCard({ provider, onRefresh }: { provider: AdminIntelligence["providers"][number]; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const settings = !Array.isArray(provider.settings) ? provider.settings : {};
  const [draft, setDraft] = useState({
    displayName: provider.displayName,
    baseUrl: "",
    secretRef: "",
    availability: asString(settings.availability ?? "available"),
    defaultModel: asString(settings.defaultModel ?? ""),
    fallbackModel: asString(settings.fallbackModel ?? ""),
    internalLayer: settings.internalLayer === true,
    featureModels: JSON.stringify(settings.featureModels ?? {}, null, 2),
    quotas: JSON.stringify(settings.quotas ?? {}, null, 2),
    costMetadata: JSON.stringify(settings.costMetadata ?? {}, null, 2),
  });
  return (
    <Card title={provider.displayName} actions={<Badge tone={provider.configured ? "good" : "warn"}>{provider.configured ? "configured" : "needs credential"}</Badge>}>
      <div className="admin-secret-state">Credential fingerprint: {provider.credentialFingerprint ?? "not configured"}</div>
      <form className="admin-form" onSubmit={(event) => {
        event.preventDefault();
        void api.adminSaveIntelligenceProvider(provider.slug, {
          displayName: draft.displayName,
          baseUrl: draft.baseUrl || undefined,
          secretRef: draft.secretRef || undefined,
          availability: draft.availability,
          defaultModel: draft.defaultModel || undefined,
          fallbackModel: draft.fallbackModel || undefined,
          internalLayer: draft.internalLayer,
          featureModels: JSON.parse(draft.featureModels || "{}"),
          quotas: JSON.parse(draft.quotas || "{}"),
          costMetadata: JSON.parse(draft.costMetadata || "{}"),
        }).then(onRefresh);
      }}>
        <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
        <input value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })} placeholder="Default model" />
        <input value={draft.fallbackModel} onChange={(event) => setDraft({ ...draft, fallbackModel: event.target.value })} placeholder="Fallback model" />
        <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="Provider base URL, no secrets" />
        <input value={draft.secretRef} onChange={(event) => setDraft({ ...draft, secretRef: event.target.value })} placeholder="Mox Vault credential ref" />
        <select value={draft.availability} onChange={(event) => setDraft({ ...draft, availability: event.target.value })}>
          <option value="available">Available</option>
          <option value="degraded">Degraded</option>
          <option value="disabled">Disabled</option>
        </select>
        <label className="admin-check"><input type="checkbox" checked={draft.internalLayer} onChange={(event) => setDraft({ ...draft, internalLayer: event.target.checked })} /> Internal intelligence layer</label>
        <textarea value={draft.featureModels} onChange={(event) => setDraft({ ...draft, featureModels: event.target.value })} />
        <textarea value={draft.quotas} onChange={(event) => setDraft({ ...draft, quotas: event.target.value })} />
        <textarea value={draft.costMetadata} onChange={(event) => setDraft({ ...draft, costMetadata: event.target.value })} />
        <button type="submit">Save model provider</button>
      </form>
    </Card>
  );
}

function RuntimePanel({ runtime, onRefresh }: { runtime: AdminRuntimeAgent[]; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  return (
    <Card title={`Agent runtime (${runtime.length})`}>
      <DataTable
        head={[
          { key: "displayName", label: "Agent" },
          { key: "status", label: "Status", render: (agent) => <Badge tone={toneFor(agent.status)}>{agent.status}</Badge> },
          { key: "deploymentState", label: "Deployment" },
          { key: "runtimeVersion", label: "Version", render: (agent) => agent.runtimeVersion ?? "" },
          { key: "serverPlacement", label: "Server", render: (agent) => agent.serverPlacement ?? "" },
          { key: "failures", label: "Failures", render: (agent) => agent.failures.join(", ") },
          { key: "actions", label: "", render: (agent) => (
            <div className="admin-actions-cell">
              <button type="button" onClick={() => void api.adminRuntimeAction(agent.agentId, "restart").then(onRefresh)}>Restart</button>
              <button type="button" onClick={() => void api.adminRuntimeAction(agent.agentId, "redeploy").then(onRefresh)}>Redeploy</button>
            </div>
          )}
        ]}
        rows={runtime}
      />
    </Card>
  );
}

function NotificationsPanel({ jobs, onRefresh }: { jobs?: AdminNotificationJobs; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [form, setForm] = useState({ audienceType: "all", audienceValue: "", title: "", body: "", severity: "info", category: "system", scheduledAt: "" });
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [inspectJob, setInspectJob] = useState<AdminNotificationJobDetails | null>(null);

  const payload = () => ({
    idempotencyKey: `admin-${Date.now()}`,
    audience: form.audienceType === "all" ? { type: "all" } : form.audienceType === "org" ? { type: "org", orgId: form.audienceValue } : form.audienceType === "plan" ? { type: "plan", planTier: form.audienceValue } : { type: "region", regionCode: form.audienceValue },
    payload: { title: form.title, body: form.body, severity: form.severity, category: form.category },
    scheduledAt: form.scheduledAt || undefined,
  });

  const submit = (event: FormEvent, mode: "send" | "schedule") => {
    event.preventDefault();
    const action = mode === "send" ? api.adminSendNotification(payload()) : api.adminScheduleNotification(payload());
    void action.then(onRefresh);
  };

  return (
    <>
      <Card title="Compose notification">
        <form className="admin-form" onSubmit={(event) => submit(event, form.scheduledAt ? "schedule" : "send")}>
          <select value={form.audienceType} onChange={(event) => setForm({ ...form, audienceType: event.target.value })}>
            <option value="all">All users</option>
            <option value="org">Organization</option>
            <option value="plan">Plan</option>
            <option value="region">Region</option>
          </select>
          <input value={form.audienceValue} onChange={(event) => setForm({ ...form, audienceValue: event.target.value })} placeholder="Audience value" />
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Title" required />
          <textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} placeholder="Body" required />
          <select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="Category" />
          <input type="datetime-local" value={form.scheduledAt} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button type="submit">{form.scheduledAt ? "Schedule" : "Send now"}</button>
            <button type="button" onClick={async () => {
              if (!form.title || !form.body) return;
              const res = await api.adminPreviewNotification({ title: form.title, body: form.body });
              setPreview({ title: asString(res.title ?? form.title), body: asString(res.body ?? form.body) });
            }}>Preview before send</button>
          </div>
          {preview && (
            <div style={{ marginTop: "12px", padding: "12px", background: "rgba(255,255,255,0.05)", borderRadius: "6px", border: "1px solid var(--color-border)" }}>
              <strong>Preview Output:</strong>
              <div style={{ fontWeight: "bold", marginTop: "4px" }}>{preview.title}</div>
              <div style={{ marginTop: "4px" }}>{preview.body}</div>
            </div>
          )}
        </form>
      </Card>

      {inspectJob && (
        <Card title={`Job Details: ${inspectJob.id}`} actions={<button type="button" onClick={() => setInspectJob(null)}>Close</button>}>
          <div style={{ display: "grid", gap: "8px" }}>
            <div><strong>Status:</strong> <Badge tone={toneFor(inspectJob.status)}>{inspectJob.status}</Badge></div>
            <div><strong>Audience:</strong> {inspectJob.audienceType} {inspectJob.audienceValue ? `(${inspectJob.audienceValue})` : ""}</div>
            <div><strong>Fanout:</strong> {inspectJob.fanoutDone} / {inspectJob.fanoutTotal}</div>
            {inspectJob.lastError && <div style={{ color: "var(--color-bad)" }}><strong>Error:</strong> {inspectJob.lastError}</div>}
            <div><strong>Created At:</strong> {inspectJob.createdAt}</div>
            {inspectJob.scheduledAt && <div><strong>Scheduled At:</strong> {inspectJob.scheduledAt}</div>}
          </div>
        </Card>
      )}

      <Card title="Notification jobs" actions={jobs ? <Badge tone="accent">{jobs.stats.scheduled} scheduled</Badge> : null}>
        <DataTable
          head={[
            { key: "id", label: "ID", render: (job) => <code>{asString(job.id).slice(0, 8)}</code> },
            { key: "audienceType", label: "Audience", render: (job) => asString(job.audienceType) },
            { key: "title", label: "Title", render: (job) => asString(job.title) },
            { key: "status", label: "Status", render: (job) => <Badge tone={toneFor(asString(job.status))}>{asString(job.status)}</Badge> },
            { key: "fanout", label: "Fanout", render: (job) => `${asString(job.fanoutDone)} / ${asString(job.fanoutTotal)}` },
            { key: "scheduledAt", label: "Scheduled At", render: (job) => asString(job.scheduledAt) || "Immediate" },
            { key: "actions", label: "Actions", render: (job) => (
              <div className="admin-actions-cell" style={{ display: "flex", gap: "6px" }}>
                <button type="button" onClick={async () => {
                  const details = await api.adminGetNotificationJob(asString(job.id));
                  setInspectJob(details);
                }}>Inspect</button>
                {job.status === "scheduled" && (
                  <button type="button" className="danger" onClick={() => void api.adminCancelNotificationJob(asString(job.id)).then(onRefresh)}>Cancel</button>
                )}
              </div>
            )}
          ]}
          rows={jobs?.jobs ?? []}
          empty="No notification jobs."
        />
      </Card>
    </>
  );
}

function OperationsPanel({ operations, onRefresh }: { operations?: AdminOperations; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [flagDraft, setFlagDraft] = useState({ key: "", orgId: "", enabled: "true", rollout: "" });
  const [backupOrg, setBackupOrg] = useState("");
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

  if (!operations) return <EmptyState>Loading operations.</EmptyState>;
  return (
    <>
      <div className="grid grid-2">
        <Card title="Feature flags management">
          <form className="admin-inline-form" onSubmit={(e) => {
            e.preventDefault();
            if (!flagDraft.key || !flagDraft.orgId) return;
            let rollout: Record<string, unknown> | undefined;
            try { if (flagDraft.rollout) rollout = JSON.parse(flagDraft.rollout); } catch {}
            void api.adminSaveFeatureFlag({ ...flagDraft, rollout }).then(() => {
              setFlagDraft({ key: "", orgId: "", enabled: "true", rollout: "" });
              return onRefresh();
            });
          }}>
            <input value={flagDraft.key} onChange={(e) => setFlagDraft({ ...flagDraft, key: e.target.value })} placeholder="Flag key" required />
            <input value={flagDraft.orgId} onChange={(e) => setFlagDraft({ ...flagDraft, orgId: e.target.value })} placeholder="Target Org ID" required />
            <select value={flagDraft.enabled} onChange={(e) => setFlagDraft({ ...flagDraft, enabled: e.target.value })}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
            <input value={flagDraft.rollout} onChange={(e) => setFlagDraft({ ...flagDraft, rollout: e.target.value })} placeholder='Rollout JSON' />
            <button type="submit">Save flag</button>
          </form>
          <div style={{ marginTop: "12px" }}>
            <DataTable
              head={[
                { key: "key", label: "Key", render: (flag) => <code>{asString(flag.key)}</code> },
                { key: "orgId", label: "Org", render: (flag) => asString(flag.orgId).slice(0, 8) },
                { key: "enabled", label: "Enabled", render: (flag) => <Badge tone={asString(flag.enabled) === "true" ? "good" : "bad"}>{asString(flag.enabled)}</Badge> },
                { key: "actions", label: "Actions", render: (flag) => <button type="button" className="danger" onClick={() => void api.adminDeleteFeatureFlag(asString(flag.key)).then(onRefresh)}>Delete</button> }
              ]}
              rows={operations.featureFlags}
              empty="No flags set."
            />
          </div>
        </Card>

        <Card title="Backups operations" actions={restoreStatus ? <Badge tone="good">{restoreStatus}</Badge> : null}>
          <form className="admin-inline-form" onSubmit={(e) => {
            e.preventDefault();
            if (!backupOrg) return;
            void api.adminRunBackup({ orgId: backupOrg }).then(() => {
              setBackupOrg("");
              return onRefresh();
            });
          }}>
            <input value={backupOrg} onChange={(e) => setBackupOrg(e.target.value)} placeholder="Target Org ID" required />
            <button type="submit">Trigger tenant backup</button>
          </form>
          <div style={{ marginTop: "12px" }}>
            <DataTable
              head={[
                { key: "id", label: "ID", render: (bkp) => <code>{asString(bkp.id).slice(0, 8)}</code> },
                { key: "orgId", label: "Org", render: (bkp) => asString(bkp.orgId).slice(0, 8) },
                { key: "location", label: "Location", render: (bkp) => asString(bkp.location) },
                { key: "actions", label: "Actions", render: (bkp) => <button type="button" onClick={() => void api.adminRestoreTest(asString(bkp.id)).then(() => setRestoreStatus(`Verified ${asString(bkp.id).slice(0, 8)}`))}>Test Restore</button> }
              ]}
              rows={operations.backups}
              empty="No backups."
            />
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Jobs and queues"><AdminDataTable columns={["id", "kind", "state", "attempts", "lastError"]} rows={[...operations.queues, ...operations.jobs]} /></Card>
        <Card title="Incidents"><AdminDataTable columns={["incidentId", "kind", "severity", "status", "title"]} rows={operations.incidents} /></Card>
        <Card title="Abuse"><AdminDataTable columns={["id", "orgId", "category", "severity", "status"]} rows={operations.abuse} /></Card>
        <Card title="Cost and margin ledger"><AdminDataTable columns={["entryId", "kind", "category", "amountMinor", "currency", "providerName", "at"]} rows={operations.costLedger} /></Card>
      </div>

      <Card title="Audit Log">
        <AdminDataTable columns={["at", "actorType", "actorId", "action", "resourceType", "resourceId", "result"]} rows={operations.audit} />
      </Card>
    </>
  );
}

function ContractsPanel({ contracts, onRefresh }: { contracts: AdminEnterpriseContract[]; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [draft, setDraft] = useState({
    orgId: "",
    contractRef: "",
    active: true,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveUntil: "",
    customPriceMinor: "",
    currency: "USD",
    values: "{}",
    metadata: {
      includedNodes: 1,
      dedicatedDatabase: false,
      dedicatedRuntime: false,
      ssoSamlReady: false,
      whiteLabel: false,
    },
  });

  return (
    <>
      <Card title={`Enterprise Contracts (${contracts.length})`}>
        <DataTable
          head={[
            { key: "contractRef", label: "Contract Ref", render: (c) => <code>{c.contractRef}</code> },
            { key: "orgId", label: "Org", render: (c) => c.orgName ?? c.orgId },
            { key: "active", label: "Status", render: (c) => <Badge tone={c.active ? "good" : "bad"}>{c.active ? "Active" : "Inactive"}</Badge> },
            { key: "effectiveFrom", label: "Effective From" },
            { key: "effectiveUntil", label: "Effective Until", render: (c) => c.effectiveUntil ?? "Perpetual" },
            { key: "createdAt", label: "Created At" },
            { key: "actions", label: "Actions", render: (c) => c.active ? (
                <button type="button" className="danger" onClick={() => void api.adminDeactivateEnterpriseContract(c.contractRef).then(onRefresh)}>Deactivate</button>
              ) : (
                <span style={{ color: "var(--color-muted)" }}>Deactivated</span>
              )
            }
          ]}
          rows={contracts}
          empty="No enterprise contracts found."
        />
      </Card>

      <Card title="Author Enterprise Contract">
        <form className="admin-form" onSubmit={(e) => {
          e.preventDefault();
          if (!draft.orgId || !draft.contractRef) return;
          let parsedValues: Record<string, unknown> = {};
          try {
            parsedValues = JSON.parse(draft.values || "{}");
          } catch {}

          void api.adminSaveEnterpriseContract({
            orgId: draft.orgId,
            contractRef: draft.contractRef,
            active: draft.active,
            effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : new Date().toISOString(),
            effectiveUntil: draft.effectiveUntil ? new Date(draft.effectiveUntil).toISOString() : null,
            values: parsedValues,
            metadata: draft.metadata,
          }).then(() => {
            setDraft({
              orgId: "",
              contractRef: "",
              active: true,
              effectiveFrom: new Date().toISOString().slice(0, 10),
              effectiveUntil: "",
              customPriceMinor: "",
              currency: "USD",
              values: "{}",
              metadata: {
                includedNodes: 1,
                dedicatedDatabase: false,
                dedicatedRuntime: false,
                ssoSamlReady: false,
                whiteLabel: false,
              },
            });
            return onRefresh();
          });
        }}>
          <div className="grid grid-2">
            <input value={draft.orgId} onChange={(e) => setDraft({ ...draft, orgId: e.target.value })} placeholder="Organization ID" required />
            <input value={draft.contractRef} onChange={(e) => setDraft({ ...draft, contractRef: e.target.value })} placeholder="Contract Ref (e.g. ACME-2026)" required />
            <div>
              <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Effective From</label>
              <input type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} required />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Effective Until (optional)</label>
              <input type="date" value={draft.effectiveUntil} onChange={(e) => setDraft({ ...draft, effectiveUntil: e.target.value })} />
            </div>
          </div>

          <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px", margin: "8px 0" }}>
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active
          </label>

          <div style={{ margin: "12px 0" }}>
            <label style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Custom Entitlement Values (JSON):</label>
            <textarea value={draft.values} onChange={(e) => setDraft({ ...draft, values: e.target.value })} placeholder='{ "agents_limit": 100, "custom_integrations": true }' style={{ width: "100%", height: "80px" }} />
          </div>

          <div style={{ margin: "12px 0", display: "flex", gap: "16px", flexWrap: "wrap" }}>
            <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <input type="checkbox" checked={draft.metadata.dedicatedDatabase} onChange={(e) => setDraft({ ...draft, metadata: { ...draft.metadata, dedicatedDatabase: e.target.checked } })} /> Dedicated DB
            </label>
            <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <input type="checkbox" checked={draft.metadata.dedicatedRuntime} onChange={(e) => setDraft({ ...draft, metadata: { ...draft.metadata, dedicatedRuntime: e.target.checked } })} /> Dedicated Runtime
            </label>
            <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <input type="checkbox" checked={draft.metadata.ssoSamlReady} onChange={(e) => setDraft({ ...draft, metadata: { ...draft.metadata, ssoSamlReady: e.target.checked } })} /> SSO SAML Ready
            </label>
            <label className="admin-check" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <input type="checkbox" checked={draft.metadata.whiteLabel} onChange={(e) => setDraft({ ...draft, metadata: { ...draft.metadata, whiteLabel: e.target.checked } })} /> White-label
            </label>
          </div>

          <button type="submit">Save Enterprise Contract</button>
        </form>
      </Card>
    </>
  );
}
