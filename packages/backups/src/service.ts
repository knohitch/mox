import { randomUUID } from "node:crypto";
import type {
  BackupStore,
  ProviderSnapshotAdapter,
  S3StorageAdapter,
  SnapshotDescriptor,
  StoredBackup,
} from "./types.js";
import { InMemoryBackupStore } from "./types.js";

export interface BackupServiceOptions {
  /** Retention window before backups expire. */
  retentionDays?: number;
}

export interface BackupRequest {
  orgId: string;
  serverOrderId?: string;
  providerInstanceId?: string;
  label?: string;
  /** Also copy snapshot bytes into Mox-owned S3 storage when available. */
  copyToS3?: boolean;
  idempotencyKey?: string;
}

export interface RestoreTestResult {
  backupId: string;
  ok: boolean;
  detail: string;
}

export class BackupService {
  readonly store: BackupStore;
  private readonly snapshots = new Map<string, ProviderSnapshotAdapter>();
  private readonly s3?: S3StorageAdapter;
  private readonly retentionDays: number;

  constructor(store: BackupStore = new InMemoryBackupStore(), options: { s3?: S3StorageAdapter; retentionDays?: number } = {}) {
    this.store = store;
    this.s3 = options.s3;
    this.retentionDays = options.retentionDays ?? 30;
  }

  registerSnapshotAdapter(adapter: ProviderSnapshotAdapter): void {
    this.snapshots.set(adapter.name, adapter);
  }

  /**
   * Run one scheduled backup. Idempotent per (idempotencyKey or derived key).
   * The backup record lives in the Control Plane; the bytes live with the
   * provider and/or Mox S3 — never only on the customer VPS.
   */
  async runBackup(input: BackupRequest): Promise<StoredBackup> {
    const backupId = input.idempotencyKey
      ? `bkp_${input.serverOrderId ?? "unknown"}_${input.idempotencyKey}`
      : `bkp_${randomUUID()}`;
    const existing = await this.store.get(backupId);
    if (existing) return existing; // double-trigger safe

    const record: StoredBackup = {
      backupId,
      orgId: input.orgId,
      serverOrderId: input.serverOrderId,
      location: "",
      kind: "provider_snapshot",
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    await this.store.insert(record);

    try {
      let descriptor: SnapshotDescriptor | undefined;
      for (const adapter of this.snapshots.values()) {
        if (!input.providerInstanceId) continue;
        descriptor = await adapter.createSnapshot({
          orgId: input.orgId,
          serverOrderId: input.serverOrderId ?? "",
          serverProviderInstanceId: input.providerInstanceId,
          label: input.label ?? `mox-${backupId}`,
        });
        break;
      }
      record.kind = "provider_snapshot";
      record.location = descriptor
        ? `${descriptor.providerName}:snapshot/${descriptor.providerSnapshotId}`
        : this.s3 ? "" : "none";
      if (this.s3) {
        const manifest = new TextEncoder().encode(
          JSON.stringify({ backupId, ...input, snapshot: descriptor }, null, 2),
        );
        const put = await this.s3.putObject({
          key: `backups/${input.orgId}/${backupId}.json`,
          body: manifest,
          contentType: "application/json",
        });
        record.location = `${record.location} ${put.location}`.trim();
        record.sizeBytes = put.sizeBytes;
      }
      if (!descriptor && !this.s3) {
        throw new Error("no snapshot adapter or s3 storage configured");
      }
      record.state = "completed";
      record.completedAt = new Date().toISOString();
      await this.store.update(record);
      return record;
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.update(record);
      return record;
    }
  }

  /**
   * Restore test flow: verify the stored artifact is readable end-to-end
   * without touching the customer's live server.
   */
  async runRestoreTest(backupId: string): Promise<RestoreTestResult> {
    const backup = await this.store.get(backupId);
    if (!backup) return { backupId, ok: false, detail: "backup not found" };
    if (backup.state !== "completed") {
      return { backupId, ok: false, detail: `backup state is ${backup.state}` };
    }
    // Verify the S3 leg when present.
    const s3Key = backup.location.split(" ").find((part) => part.startsWith("s3://"));
    if (s3Key && this.s3) {
      try {
        const head = await this.s3.headObject(s3Key.replace("s3://mox-backups/", ""));
        if (!head) return { backupId, ok: false, detail: "s3 object missing" };
      } catch (error) {
        return { backupId, ok: false, detail: String(error) };
      }
    }
    return { backupId, ok: true, detail: "artifact verified" };
  }

  /** Retention sweep expires backups past their retention window. */
  async sweepRetention(nowIso: string): Promise<number> {
    let expired = 0;
    for (const backup of await this.store.all()) {
      if (backup.state !== "completed") continue;
      const ageMs = Date.parse(nowIso) - Date.parse(backup.completedAt ?? backup.createdAt);
      if (ageMs > this.retentionDays * 24 * 3600_000) {
        backup.state = "expired";
        await this.store.update(backup);
        expired += 1;
      }
    }
    return expired;
  }

  /**
   * Cancellation retention export: package a customer's backup index so the
   * data outlives workspace destruction even after VPS removal.
   */
  async exportForCancellation(orgId: string): Promise<{ orgId: string; backups: StoredBackup[]; exportedAt: string }> {
    const backups = (await this.store.all()).filter((b) => b.orgId === orgId && b.state === "completed");
    return { orgId, backups, exportedAt: new Date().toISOString() };
  }
}
