import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity-users.js";

/**
 * Compute orchestration domain: server orders as desired-state, durable
 * provider operations, SSH keys, provider accounts and Mox Node lifecycle.
 *
 * The control plane owns all authoritative state. Mox Node runs on a
 * customer-controlled VPS and is therefore an untrusted reporter.
 */

export const orderState = pgEnum("server_order_state", [
  "requested",
  "provisioning",
  "running",
  "error",
  "resizing",
  "stopping",
  "stopped",
  "cancelling",
  "canceled",
  "retention",
  "destroyed",
]);

export const opState = pgEnum("server_operation_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);

/** Admin-configured classes map plans to provider SKUs; never hard-coded. */
export const computeClasses = pgTable("compute_classes", {
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  minVcpu: integer("min_vcpu").notNull(),
  minRamGb: integer("min_ram_gb").notNull(),
  /** providerName+region+sku candidates in preference order. */
  skuMap: jsonb("sku_map").notNull().default([]),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    accountLabel: text("account_label").notNull(),
    regionCode: text("region_code"),
    commercialStatus: text("commercial_status").notNull().default("active"),
    healthScore: integer("health_score").notNull().default(100),
    credentialRefId: uuid("credential_ref_id"),
    enabled: boolean("enabled").notNull().default(true),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_accounts_label_key").on(t.providerName, t.accountLabel)],
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ssh_keys_org_idx").on(t.orgId)],
);

/** Authoritative VPS desired-state record. */
export const serverOrders = pgTable(
  "server_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    subscriptionItemId: uuid("subscription_item_id"),
    computeClassCode: text("compute_class_code")
      .notNull()
      .references(() => computeClasses.code),
    state: orderState("state").notNull().default("requested"),
    providerName: text("provider_name"),
    providerAccountId: uuid("provider_account_id").references(() => providerAccounts.id),
    regionCode: text("region_code"),
    providerSku: text("provider_sku"),
    providerInstanceId: text("provider_instance_id"),
    ipv4: text("ipv4"),
    ipv6: text("ipv6"),
    hostname: text("hostname").notNull(),
    sshKeyId: uuid("ssh_key_id").references(() => sshKeys.id, { onDelete: "set null" }),
    /** Root credential delivery happens out-of-band once, never logged. */
    rootCredentialRefId: uuid("root_credential_ref_id"),
    reverseDns: text("reverse_dns"),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("server_orders_org_idem_key").on(t.orgId, t.idempotencyKey),
    index("server_orders_state_idx").on(t.state),
    index("server_orders_org_idx").on(t.orgId),
  ],
);

/**
 * Durable provider operations. leaseUntil allows multiple workers/processes to
 * claim work atomically while making abandoned claims recoverable after a
 * worker crash.
 */
export const serverOperations = pgTable(
  "server_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => serverOrders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    state: opState("state").notNull().default("queued"),
    providerOperationId: text("provider_operation_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("server_operations_order_kind_key").on(t.orderId, t.kind, t.idempotencyKey),
    index("server_operations_due_idx").on(t.state, t.nextAttemptAt),
    index("server_operations_lease_idx").on(t.state, t.leaseUntil),
  ],
);

/**
 * One-time node enrollment grants. The raw token is never stored. tokenId is
 * safe to persist; tokenHash is a defense-in-depth comparison while the
 * signature key remains outside the database. A consumed/revoked grant can
 * never be reused.
 */
export const nodeEnrollmentTokens = pgTable(
  "node_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: text("token_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => serverOrders.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByNodeId: text("consumed_by_node_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("node_enrollment_tokens_token_id_key").on(t.tokenId),
    index("node_enrollment_tokens_order_idx").on(t.orderId, t.expiresAt),
  ],
);

/** Mox Node identity + heartbeat state (untrusted/advisory telemetry). */
export const moxNodes = pgTable(
  "mox_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => serverOrders.id, { onDelete: "set null" }),
    nodeId: text("node_id").notNull(),
    /** Historical hash of the one-time enrollment token; never accepted again. */
    enrollTokenHash: text("enroll_token_hash").notNull(),
    /** Hash of the currently valid node bearer token. Raw token is returned once. */
    agentTokenHash: text("agent_token_hash"),
    version: text("version"),
    capabilities: jsonb("capabilities").notNull().default([]),
    metrics: jsonb("metrics"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
  },
  (t) => [uniqueIndex("mox_nodes_node_id_key").on(t.nodeId)],
);

/** Signed command dispatch log for audit and replay protection. */
export const nodeCommands = pgTable(
  "node_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: text("node_id")
      .notNull()
      .references(() => moxNodes.nodeId, { onDelete: "cascade" }),
    nonce: text("nonce").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("node_commands_nonce_key").on(t.nonce)],
);

/** Durable generic nonce consumption for control-plane replay guards. */
export const nodeConsumedNonces = pgTable("node_consumed_nonces", {
  nonce: text("nonce").primaryKey(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
});
