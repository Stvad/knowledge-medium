ALTER TABLE "public"."blocks"
  ADD COLUMN IF NOT EXISTS "field_id" "text";

CREATE INDEX IF NOT EXISTS "idx_blocks_field_parent"
  ON "public"."blocks" USING "btree" ("workspace_id", "field_id", "parent_id")
  WHERE (("deleted" = false) AND ("field_id" IS NOT NULL));
