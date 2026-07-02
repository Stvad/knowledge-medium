CREATE INDEX IF NOT EXISTS "idx_blocks_workspace_recent_content"
  ON "public"."blocks" USING "btree" ("workspace_id", "updated_at" DESC, "id" ASC)
  WHERE (("deleted" = false) AND ("content" <> ''::"text"));
