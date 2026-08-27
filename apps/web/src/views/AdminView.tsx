import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useMox } from "../api/store.js";
import type {
  AdminCompute,
  AdminCustomer,
  AdminIntelligence,
  AdminNotificationJobs,
  AdminOperations,
  AdminOverview,
  AdminPaymentProvider,
  AdminPlans,
  AdminRuntimeAgent,
  AdminStaff,
  CreatedStaffInvite,
} from "../api/types.js";
import { Badge, Card, EmptyState } from "../ui/primitives.js";
import { ADMIN_TAB_LABEL, canManageStaff, visibleAdminTabs } from "../concepts/staffNav.js";

type AdminTab = "dashboard" | "customers" | "plans" | "payments" | "compute" | "intelligence" | "runtime" | "notifications" | "operations" | "staff";

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
  if (["active", "running", "healthy", "completed", "current", "enabled", "available"].some((x) => v.includes(x))) return "good";
  if (["pending", "scheduled", "maintenance", "trial", "grace"].some((x) => v.includes(x))) return "warn";
  if (["failed", "error", "denied", "suspended", "canceled", "not_configured"].some((x) => v.includes(x))) return "bad";
  return "neutral";
}

function DataTable({ columns, rows, empty = "No records." }: { columns: string[]; rows: Array<Record<string, unknown>>; empty?: string }) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={asString(row.id ?? row.key ?? row.code ?? row.providerName ?? row.slug ?? index)}>
              {columns.map((column) => (
                <td key={column}>{asString(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  const [tab, setTab] = useState<AdminTab>("dashboard");
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
      ]);
      const [o, c, p, pay, comp, intel, run, ops, jobs, staffRes] = results;
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
    operations: <OperationsPanel operations={operations} />,
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
      <header className="admin-console-head">
        <div>
          <div className="admin-kicker">Mox Admin</div>
          <h1>Platform control</h1>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "Refreshing" : "Refresh"}
        </button>
      </header>
      <nav className="admin-tabs" aria-label="Mox Admin sections">
        {visibleTabs.map((key) => (
          <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {ADMIN_TAB_LABEL[key]}
          </button>
        ))}
      </nav>
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
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr><th>Display name</th><th>Email</th><th>Role</th><th>Surface</th><th>Status</th><th>Granted at</th><th /></tr>
              </thead>
              <tbody>
                {staff.members.map((member) => (
                  <tr key={`${member.userId}:${member.role}`}>
                    <td>{member.displayName}</td>
                    <td>{member.email}</td>
                    <td>{member.role}</td>
                    <td>{member.surface}</td>
                    <td>{member.revokedAt ? "revoked" : member.enabled ? "active" : "disabled"}</td>
                    <td>{member.createdAt}</td>
                    <td className="admin-actions-cell">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>Email</th><th>Role</th><th>Surface</th><th>Expires</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {staff.invites.map((inviteRow) => (
                    <tr key={inviteRow.invitationId}>
                      <td>{inviteRow.email}</td>
                      <td>{inviteRow.role}</td>
                      <td>{inviteRow.surface}</td>
                      <td>{inviteRow.expiresAt}</td>
                      <td>{inviteRow.revokedAt ? "revoked" : inviteRow.consumedAt ? "consumed" : "pending"}</td>
                      <td className="admin-actions-cell">
                        {!inviteRow.revokedAt && !inviteRow.consumedAt && (
                          <button type="button" className="danger" onClick={() => void confirmAnd(async () => {
                            await api.adminRevokeStaffInvite(inviteRow.invitationId);
                            await onRefresh();
                          })}>Revoke</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
  if (!overview) return <EmptyState>Loading Mox Admin dashboard.</EmptyState>;
  const m = overview.metrics;
  return (
    <>
      <div className="admin-metrics">
        <Metric label="Customers" value={m.customers} />
        <Metric label="Active subscriptions" value={m.activeSubscriptions} />
        <Metric label="Payment failures" value={m.paymentFailures} />
        <Metric label="Active servers" value={m.activeServers} />
        <Metric label="Provisioning failures" value={m.serverProvisioningFailures} />
        <Metric label="Runtime health" value={`${m.runtimeAgentHealth.total - m.runtimeAgentHealth.degraded}/${m.runtimeAgentHealth.total}`} detail="agents healthy" />
        <Metric label="Provider incidents" value={m.providerIncidents} />
        <Metric label="Notifications" value={m.notifications} />
        <Metric label="Abuse" value={m.abuse} />
        <Metric label="Margin" value={money(Number(m.costMargin.revenueMinor) - Number(m.costMargin.costMinor), m.costMargin.currency)} />
      </div>
      <div className="grid grid-3">
        <Card title="Provider incidents">
          <DataTable columns={["incidentId", "kind", "severity", "status", "title"]} rows={overview.incidents} />
        </Card>
        <Card title="Recent notification jobs">
          <DataTable columns={["id", "audienceType", "status", "fanoutDone", "fanoutTotal"]} rows={overview.notifications} />
        </Card>
        <Card title="Open abuse">
          <DataTable columns={["id", "orgId", "category", "severity", "status"]} rows={overview.abuse} />
        </Card>
      </div>
    </>
  );
}

function CustomersPanel({ customers, onRefresh }: { customers: AdminCustomer[]; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [selectedId, setSelectedId] = useState<string | null>(customers[0]?.orgId ?? null);
  const [note, setNote] = useState("");
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
              <div className="admin-action-row">
                <button type="button" className="danger" onClick={() => void api.adminCustomerAction(selected.orgId, "suspend", "admin_controlled").then(onRefresh)}>Suspend</button>
                <button type="button" onClick={() => void api.adminCustomerAction(selected.orgId, "reactivate").then(onRefresh)}>Reactivate</button>
              </div>
              <DataTable columns={["email", "displayName", "role", "disabledAt"]} rows={selected.users} />
            </Card>
            <Card title="Subscriptions, servers and agents">
              <DataTable columns={["id", "plan", "tier", "state", "failedRenewals"]} rows={selected.subscriptions} />
              <DataTable columns={["id", "hostname", "providerName", "regionCode", "state", "lastError"]} rows={selected.servers} />
              <DataTable columns={["agentId", "displayName", "status", "currentVersion"]} rows={selected.agents} />
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
              <DataTable columns={["at", "actorId", "note"]} rows={selected.supportNotes} />
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
  if (!plans) return <EmptyState>Loading plan catalog.</EmptyState>;
  return (
    <>
      <div className="grid grid-2">
        <Card title="Plan versions">
          <DataTable columns={["id", "productId", "version", "status", "activatedAt"]} rows={plans.planVersions} />
        </Card>
        <Card title="Entitlements">
          <DataTable columns={["key", "valueType", "description", "defaultValue"]} rows={plans.entitlementDefinitions} />
        </Card>
      </div>
      <Card title="Regional price books">
        <DataTable columns={["id", "productId", "pricingRegion", "mode", "baseCurrency", "baseAmountMinor", "fxRateScaled"]} rows={plans.priceBooks} />
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
          <DataTable columns={["code", "displayName", "exponent"]} rows={plans.currencies} />
        </Card>
        <Card title="Add-ons">
          <DataTable columns={["code", "displayName", "consumable", "unit"]} rows={plans.addons} />
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
          <DataTable columns={["providerName", "accountLabel", "regionCode", "commercialStatus", "healthScore", "enabled", "hasCredentialRef"]} rows={compute.accounts} />
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
          <DataTable columns={["code", "displayName", "minVcpu", "minRamGb", "active"]} rows={compute.classes} />
        </Card>
      </div>
      <Card title="Orders and lifecycle">
        <DataTable columns={["id", "orgId", "hostname", "providerName", "regionCode", "providerSku", "state", "lastError"]} rows={compute.orders} />
      </Card>
      <Card title="Mox Node health">
        <DataTable columns={["nodeId", "orgId", "orderId", "version", "status", "lastHeartbeatAt"]} rows={compute.nodes} />
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
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Agent</th><th>Status</th><th>Deployment</th><th>Version</th><th>Server</th><th>Failures</th><th /></tr></thead>
          <tbody>
            {runtime.map((agent) => (
              <tr key={agent.agentId}>
                <td>{agent.displayName}</td>
                <td><Badge tone={toneFor(agent.status)}>{agent.status}</Badge></td>
                <td>{agent.deploymentState}</td>
                <td>{agent.runtimeVersion ?? ""}</td>
                <td>{agent.serverPlacement ?? ""}</td>
                <td>{agent.failures.join(", ")}</td>
                <td className="admin-actions-cell">
                  <button type="button" onClick={() => void api.adminRuntimeAction(agent.agentId, "restart").then(onRefresh)}>Restart</button>
                  <button type="button" onClick={() => void api.adminRuntimeAction(agent.agentId, "redeploy").then(onRefresh)}>Redeploy</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NotificationsPanel({ jobs, onRefresh }: { jobs?: AdminNotificationJobs; onRefresh: () => Promise<void> }) {
  const { api } = useMox();
  const [form, setForm] = useState({ audienceType: "all", audienceValue: "", title: "", body: "", severity: "info", category: "system", scheduledAt: "" });
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
          <button type="submit">{form.scheduledAt ? "Schedule" : "Send now"}</button>
        </form>
      </Card>
      <Card title="Notification jobs" actions={jobs ? <Badge tone="accent">{jobs.stats.scheduled} scheduled</Badge> : null}>
        <DataTable columns={["id", "audienceType", "title", "status", "fanoutDone", "fanoutTotal", "scheduledAt"]} rows={jobs?.jobs ?? []} />
      </Card>
    </>
  );
}

function OperationsPanel({ operations }: { operations?: AdminOperations }) {
  if (!operations) return <EmptyState>Loading operations.</EmptyState>;
  return (
    <div className="grid grid-2">
      <Card title="Jobs and queues"><DataTable columns={["id", "kind", "state", "attempts", "lastError"]} rows={[...operations.queues, ...operations.jobs]} /></Card>
      <Card title="Incidents"><DataTable columns={["incidentId", "kind", "severity", "status", "title"]} rows={operations.incidents} /></Card>
      <Card title="Backups"><DataTable columns={["id", "orgId", "kind", "location", "completedAt"]} rows={operations.backups} /></Card>
      <Card title="Abuse"><DataTable columns={["id", "orgId", "category", "severity", "status"]} rows={operations.abuse} /></Card>
      <Card title="Feature flags"><DataTable columns={["key", "orgId", "enabled", "rollout"]} rows={operations.featureFlags} /></Card>
      <Card title="Audit"><DataTable columns={["at", "actorType", "actorId", "action", "resourceType", "resourceId", "result"]} rows={operations.audit} /></Card>
      <Card title="Cost and margin ledger"><DataTable columns={["entryId", "kind", "category", "amountMinor", "currency", "providerName", "at"]} rows={operations.costLedger} /></Card>
    </div>
  );
}
