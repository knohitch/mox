/**
 * Backups (Prompt 12): BackupProvider abstraction with a provider-snapshot
 * adapter and an S3-compatible object storage adapter.
 *
 * Invariant: backups always live OUTSIDE the customer VPS. Snapshots are
 * pulled from the provider API; S3 copies are streamed to Mox-owned buckets,
 * so backup survival never depends on the customer's server staying alive.
 */

export interface SnapshotDescriptor {
  providerName: string;
  providerSnapshotId: string;
  serverProviderId: string;
  sizeGb: number;
  createdAt: string;
}

export interface StoredBackup {
  backupId: string;
  orgId: string;
  serverOrderId?: string;
  /** Where the bytes live: s3://bucket/key */
  location: string;
  kind: "provider_snapshot" | "s3_copy";
  sizeBytes?: number;
  state: "pending" | "completed" | "failed" | "expired";
  error?: string;
  createdAt: string;
  completedAt?: string;
}

/** Provider snapshot APIs (Contabo backups, Hetzner images...). */
export interface ProviderSnapshotAdapter {
  readonly name: string;
  createSnapshot(input: { orgId: string; serverOrderId: string; serverProviderInstanceId: string; label: string }): Promise<SnapshotDescriptor>;
  deleteSnapshot(providerSnapshotId: string): Promise<void>;
  restoreFromSnapshot(input: { providerSnapshotId: string; serverProviderInstanceId: string }): Promise<void>;
}

/** S3-compatible object storage (Mox-owned bucket, off the customer VPS). */
export interface S3StorageAdapter {
  readonly name: string;
  putObject(input: { key: string; body: Uint8Array; contentType?: string }): Promise<{ location: string; sizeBytes: number }>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ sizeBytes: number } | undefined>;
}

export interface BackupStore {
  insert(backup: StoredBackup): Promise<boolean>;
  update(backup: StoredBackup): Promise<void>;
  get(backupId: string): Promise<StoredBackup | undefined>;
  listForServer(serverOrderId: string): Promise<StoredBackup[]>;
  all(): Promise<StoredBackup[]>;
}

export class InMemoryBackupStore implements BackupStore {
  private readonly items = new Map<string, StoredBackup>();
  private readonly seen = new Set<string>();

  async insert(backup: StoredBackup): Promise<boolean> {
    if (this.seen.has(backup.backupId)) return false;
    this.seen.add(backup.backupId);
    this.items.set(backup.backupId, backup);
    return true;
  }

  async update(backup: StoredBackup): Promise<void> {
    this.items.set(backup.backupId, backup);
  }

  async get(backupId: string): Promise<StoredBackup | undefined> {
    return this.items.get(backupId);
  }

  async listForServer(serverOrderId: string): Promise<StoredBackup[]> {
    return [...this.items.values()].filter((b) => b.serverOrderId === serverOrderId);
  }

  async all(): Promise<StoredBackup[]> {
    return [...this.items.values()];
  }
}
