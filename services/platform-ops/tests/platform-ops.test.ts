import { describe, expect, it } from "vitest";
import { FakeComputeProvider } from "@mox/compute-providers";
import { PlatformOpsService } from "../src/service.js";
import { InMemoryAbuseStore, InMemoryIncidentStore, type Incident } from "../src/types.js";

function setup() {
  const provider = new FakeComputeProvider();
  const svc = new PlatformOpsService({
    abuseStore: new InMemoryAbuseStore(),
    incidentStore: new InMemoryIncidentStore(),
    ownership: {
      async ownerOf(serverOrderId) {
        if (serverOrderId === "srv-abuse") {
          return { orgId: "org-bad", providerName: "fake-compute", providerInstanceId: "fake-compute-srv-1", accountLabel: "primary" };
        }
        return undefined;
      },
    },
    repeatAbuseThreshold: 2,
  });
  svc.registerProvider(provider);
  // Seed the fake with a running instance matching the abuse target.
  void provider.provision({
    idempotencyKey: "seed",
    regionCode: "fsn1",
    providerSku: "CX22",
    hostname: "ws-abuse",
    sshPublicKey: "",
    cloudInitUserData: "",
  });
  return { svc, provider };
}

describe("abuse management", () => {
  it("opens cases with evidence, deadlines and ownership resolution", async () => {
    const { svc } = setup();
    const abuseCase = await svc.openAbuseCase({
      serverOrderId: "srv-abuse",
      complaintSource: "upstream_provider",
      category: "spam_outbound",
      severity: "high",
      evidence: [{ kind: "email", reference: "abuse-report-42" }],
      deadlineDays: 3,
    });
    expect(abuseCase.orgId).toBe("org-bad");
    expect(abuseCase.status).toBe("open");
    expect(abuseCase.evidence[0]?.reference).toBe("abuse-report-42");
    expect(abuseCase.deadline).toBeTruthy();

    await expect(
      svc.openAbuseCase({ serverOrderId: "srv-unknown", complaintSource: "legal", category: "x", severity: "low" }),
    ).rejects.toThrow(/unknown server order/);
  });

  it("emergency-suspends through the provider API while Mox Node is offline", async () => {
    const { svc, provider } = setup();
    const abuseCase = await svc.openAbuseCase({
      serverOrderId: "srv-abuse",
      complaintSource: "internal_monitoring",
      category: "crypto_mining",
      severity: "critical",
    });
    await svc.emergencySuspendServer({ caseId: abuseCase.caseId, actor: "admin-1" });

    // Provider-side instance stopped; node never had to answer.
    const instance = await provider.getInstance("fake-compute-srv-1");
    expect(instance.state).toBe("stopped");

    const updated = await svc.abuseStore.get(abuseCase.caseId);
    expect(updated?.status).toBe("mitigated");
    expect(updated?.actions.at(-1)?.action).toBe("emergency_suspended_via_provider");
  });

  it("tracks repeat offenders across cases", async () => {
    const { svc } = setup();
    for (let i = 0; i < 3; i += 1) {
      await svc.openAbuseCase({
        serverOrderId: "srv-abuse",
        complaintSource: "spam_report",
        category: "spam",
        severity: "medium",
      });
    }
    expect(svc.isRepeatOffender("org-bad")).toBe(true);
  });

  it("walks the full workflow: customer response → resolve/reinstate → dismiss", async () => {
    const { svc } = setup();
    const c1 = await svc.openAbuseCase({
      serverOrderId: "srv-abuse",
      complaintSource: "customer_complaint",
      category: "resource_abuse",
      severity: "low",
    });
    await svc.recordCustomerResponse(c1.caseId, "fixed the script");
    await svc.resolveCase({ caseId: c1.caseId, actor: "admin-2", reinstateServer: true });
    expect((await svc.abuseStore.get(c1.caseId))?.status).toBe("resolved");

    const c2 = await svc.openAbuseCase({
      serverOrderId: "srv-abuse",
      complaintSource: "legal",
      category: "dmca",
      severity: "high",
    });
    await svc.dismissCase(c2.caseId, "legal-1");
    expect((await svc.abuseStore.get(c2.caseId))?.status).toBe("dismissed");

    // Open list only shows unresolved.
    const open = await svc.abuseStore.listOpen();
    expect(open).toHaveLength(0);
  });
});

describe("incidents", () => {
  it("tracks lifecycle for every incident kind", async () => {
    const svc = new PlatformOpsService({ incidentStore: new InMemoryIncidentStore() });
    const kinds = ["provider_outage", "model_outage", "channel_outage", "mox_service"] as const;
    const opened: Incident[] = [];
    for (const kind of kinds) {
      opened.push(await svc.openIncident({ kind, title: `${kind} event`, severity: "major", affectedScope: "eu-central" }));
    }
    await svc.updateIncident(opened[0]!.incidentId, "identified upstream fiber cut", "identified");
    await svc.updateIncident(opened[0]!.incidentId, "traffic rerouted", "monitoring");
    await svc.updateIncident(opened[0]!.incidentId, "fully restored", "resolved");

    const incidents = await svc.listIncidents();
    expect(incidents).toHaveLength(4);
    const first = incidents.find((i) => i.incidentId === opened[0]!.incidentId)!;
    expect(first.status).toBe("resolved");
    expect(first.resolvedAt).toBeTruthy();
    expect(first.updates).toHaveLength(4);
  });
});
