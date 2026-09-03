-- Phase 06: Support escalations + staff role unification
-- Adds durable escalation workflow and extends staff role vocabulary.

-- Extend staff_role enum with billing_admin and ops_admin
ALTER TYPE "staff_role" ADD VALUE IF NOT EXISTS 'billing_admin';
ALTER TYPE "staff_role" ADD VALUE IF NOT EXISTS 'ops_admin';

-- Support escalations table
CREATE TABLE "support_escalations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "assigned_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "severity" text NOT NULL DEFAULT 'medium',
  "category" text NOT NULL DEFAULT 'general',
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'open',
  "resolution_note" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "support_escalations_org_idx" ON "support_escalations"("org_id");
CREATE INDEX "support_escalations_status_idx" ON "support_escalations"("status");
