import { describe, expect, it } from "vitest";
import { BackupService } from "../src/service.js";
import { ContaboSnapshotAdapter } from "../src/adapters.js";
import { InMemoryBackupStore, type S3StorageAdapter } from "../src/types.js";

function s3WithMemory() {
  const objects = new Map<string, Uint8Array>();
  const adapter: S3StorageAdapter = {
    name: "s3:mox-backups",
    async putObject(input) {
      objects.set(input.key, input.body);
      return { location: `s3://mox-backups/${input.key}`, sizeBytes: input.body.byteLength };
    },
    async getObject(key) {
      const body = objects.get(key);
      if (!body) throw new Error("NoSuchKey");
      return body;
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async headObject(key) {
      const body = objects.get(key);
      return body ? { sizeBytes: body.byteLength } : undefined;
    },
  };
  return { adapter, objects };
}

describe("backup service", () => {
  it("runs provider snapshots + S3 copy with idempotent re-trigger", async () => {
    const store = new InMemoryBackupStore();
    const { adapter: s3 } = s3WithMemory();
    const svc = new BackupService(store, { s3 });
    svc.registerSnapshotAdapter(
      new ContaboSnapshotAdapter({
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ id: 555, sizeGb: 20, createdDate: "2026-08-21T00:00:00Z" }] }), {
            status: 200,
          }),
      }),
    );

    const request = {
      orgId: "org-1",
      serverOrderId: "srv-1",
      providerInstanceId: "inst-9",
      idempotencyKey: "nightly-1",
    };
    const first = await svc.runBackup(request);
    expect(first.state).toBe("completed");
    expect(first.location).toContain("contabo:snapshot/555");
    expect(first.location).toContain("s3://mox-backups/");

    // Double-trigger (scheduler retry) returns the same backup.
    const second = await svc.runBackup(request);
    expect(second.backupId).toBe(first.backupId);
    expect(second.completedAt).toBe(first.completedAt);
  });

  it("marks failures honestly when no snapshot/storage target exists", async () => {
    const store = new InMemoryBackupStore();
    const svc = new BackupService(store); // nothing configured
    const result = await svc.runBackup({ orgId: "org-2", serverOrderId: "srv-x" });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("no snapshot adapter or s3 storage configured");
  });

  it("restore tests verify artifacts without touching the customer VPS", async () => {
    const store = new InMemoryBackupStore();
    const { adapter: s3 } = s3WithMemory();
    const bareSvc = new BackupService(store); // nothing configured → backup fails
    // Failed backups fail restore tests.
    const bad = await bareSvc.runBackup({ orgId: "o", serverOrderId: "s" });
    const badTest = await bareSvc.runRestoreTest(bad.backupId);
    expect(badTest.ok).toBe(false);

    const goodSvc = new BackupService(store, { s3 });
    const good = await goodSvc.runBackup({
      orgId: "o",
      serverOrderId: "s",
      providerInstanceId: "i",
      idempotencyKey: "rt",
    });
    const test = await goodSvc.runRestoreTest(good.backupId);
    expect(test.ok).toBe(true);
  });

  it("retention sweep expires old completed backups only", async () => {
    const store = new InMemoryBackupStore();
    const { adapter: s3 } = s3WithMemory();
    const svc = new BackupService(store, { s3 });
    const done = await svc.runBackup({ orgId: "o", serverOrderId: "s", providerInstanceId: "i", idempotencyKey: "old" });
    // Age it past retention.
    done.completedAt = "2026-01-01T00:00:00.000Z";
    await store.update(done);

    const expiredCount = await svc.sweepRetention("2026-08-21T00:00:00.000Z");
    expect(expiredCount).toBe(1);
    expect((await store.get(done.backupId))?.state).toBe("expired");

    // A fresh one survives.
    await svc.runBackup({ orgId: "o", serverOrderId: "s", providerInstanceId: "i", idempotencyKey: "new" });
    expect(await svc.sweepRetention(new Date().toISOString())).toBe(0);
  });

  it("exports a cancellation retention package that outlives the VPS", async () => {
    const store = new InMemoryBackupStore();
    const { adapter: s3 } = s3WithMemory();
    const svc = new BackupService(store, { s3 });
    await svc.runBackup({ orgId: "org-cancel", serverOrderId: "srv-c", providerInstanceId: "i", idempotencyKey: "a" });
    await svc.runBackup({ orgId: "other-org", serverOrderId: "srv-d", providerInstanceId: "i", idempotencyKey: "b" });

    const exportPkg = await svc.exportForCancellation("org-cancel");
    expect(exportPkg.backups).toHaveLength(1);
    expect(exportPkg.orgId).toBe("org-cancel");
    // The artifact lives in Mox-owned storage, independent of the destroyed VPS.
    expect(exportPkg.backups[0]?.location).toContain("s3://mox-backups/");
  });
});
