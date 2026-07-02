ALTER TABLE "public"."blocks"
  ADD COLUMN IF NOT EXISTS "reference_target_id" "text";

CREATE INDEX IF NOT EXISTS "idx_blocks_reference_target_parent"
  ON "public"."blocks" USING "btree" ("workspace_id", "reference_target_id", "parent_id")
  WHERE (("deleted" = false) AND ("reference_target_id" IS NOT NULL));
