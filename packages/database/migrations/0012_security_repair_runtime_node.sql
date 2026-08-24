ALTER TABLE "node_enrollment_tokens"
  ADD COLUMN IF NOT EXISTS "expected_node_id" text;

UPDATE "node_enrollment_tokens"
SET "expected_node_id" = 'node-' || "order_id"::text
WHERE "expected_node_id" IS NULL;

ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "approval_ref" text,
  ADD COLUMN IF NOT EXISTS "thread_id" uuid,
  ADD COLUMN IF NOT EXISTS "requester_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "tool_name" text,
  ADD COLUMN IF NOT EXISTS "action" text,
  ADD COLUMN IF NOT EXISTS "policy_reason" text,
  ADD COLUMN IF NOT EXISTS "correlation_id" text,
  ADD COLUMN IF NOT EXISTS "outcome" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_thread_id_threads_id_fk'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_thread_id_threads_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_ref_key"
  ON "approval_requests" ("approval_ref");
