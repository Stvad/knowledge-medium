DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'blocks'
      AND column_name = 'field_id'
  ) THEN
    INSERT INTO "public"."blocks" (
      "id",
      "workspace_id",
      "parent_id",
      "reference_target_id",
      "order_key",
      "content",
      "properties_json",
      "references_json",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "deleted"
    )
    SELECT
      legacy."id" || ':value',
      legacy."workspace_id",
      legacy."id",
      NULL,
      'a0',
      legacy."content",
      legacy."properties_json",
      legacy."references_json",
      legacy."created_at",
      legacy."updated_at",
      legacy."created_by",
      legacy."updated_by",
      legacy."deleted"
    FROM "public"."blocks" legacy
    WHERE legacy."field_id" IS NOT NULL
      AND legacy."reference_target_id" IS NULL
    ON CONFLICT ("id") DO NOTHING;

    WITH labels AS (
      SELECT
        legacy."id",
        COALESCE(
          schema_block."properties_json"::jsonb ->> 'property-schema:name',
          CASE
            WHEN legacy."field_id" LIKE 'property:%' THEN substr(legacy."field_id", length('property:') + 1)
            ELSE legacy."field_id"
          END
        ) AS "label"
      FROM "public"."blocks" legacy
      LEFT JOIN "public"."blocks" schema_block ON schema_block."id" = legacy."field_id"
      WHERE legacy."field_id" IS NOT NULL
        AND legacy."reference_target_id" IS NULL
    )
    UPDATE "public"."blocks" target
    SET
      "reference_target_id" = target."field_id",
      "content" = '[[' || replace(labels."label", ']]', '] ]') || ']]',
      "properties_json" = '{}',
      "references_json" = jsonb_build_array(jsonb_build_object(
        'id', target."field_id",
        'alias', labels."label"
      ))::text
    FROM labels
    WHERE target."id" = labels."id";
  END IF;
END $$;

DROP INDEX IF EXISTS "public"."idx_blocks_field_parent";

ALTER TABLE "public"."blocks"
  DROP COLUMN IF EXISTS "field_id";
