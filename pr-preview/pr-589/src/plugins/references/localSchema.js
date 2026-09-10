import{isMarkerSet as e,markerDoneSql as t,recordMarkerSql as n}from"../../data/internals/clientSchema.js";var r=`
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_with_references
  ON blocks (workspace_id)
  WHERE deleted = 0 AND references_json != '[]'
`,i=`
  CREATE TABLE IF NOT EXISTS block_references (
    source_id    TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    source_field TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_id, target_id, alias, source_field)
  )
`,a=`
  CREATE INDEX IF NOT EXISTS idx_block_references_target
  ON block_references (target_id, workspace_id)
`,o=`
  CREATE INDEX IF NOT EXISTS idx_block_references_ws_alias
  ON block_references (workspace_id, alias)
`,s=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${(e=>`
      INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
      SELECT
        ${e}.id,
        json_extract(je.value, '$.id'),
        ${e}.workspace_id,
        json_extract(je.value, '$.alias'),
        COALESCE(json_extract(je.value, '$.sourceField'), '')
      FROM json_each(${e}.references_json) AS je
      WHERE typeof(json_extract(je.value, '$.id')) = 'text'
        AND typeof(json_extract(je.value, '$.alias')) = 'text'
        AND (
          json_type(je.value, '$.sourceField') IS NULL
          OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
        );
`.trim())(`NEW`)}
  END
`,c=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_update
  AFTER UPDATE OF references_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = NEW.id;
    INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
    SELECT
      NEW.id,
      json_extract(je.value, '$.id'),
      NEW.workspace_id,
      json_extract(je.value, '$.alias'),
      COALESCE(json_extract(je.value, '$.sourceField'), '')
    FROM json_each(NEW.references_json) AS je
    WHERE NEW.deleted = 0
      AND typeof(json_extract(je.value, '$.id')) = 'text'
      AND typeof(json_extract(je.value, '$.alias')) = 'text'
      AND (
        json_type(je.value, '$.sourceField') IS NULL
        OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
      );
  END
`,l=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = OLD.id;
  END
`,u=`block_references_backfill_v1`,d=`block_references_source_field_v1`,f=t(u),p=n(u),m=t(d),h=n(d),g=`
  INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
  SELECT
    b.id,
    json_extract(je.value, '$.id'),
    b.workspace_id,
    json_extract(je.value, '$.alias'),
    COALESCE(json_extract(je.value, '$.sourceField'), '')
  FROM blocks b, json_each(b.references_json) AS je
  WHERE b.deleted = 0
    AND typeof(json_extract(je.value, '$.id')) = 'text'
    AND typeof(json_extract(je.value, '$.alias')) = 'text'
    AND (
      json_type(je.value, '$.sourceField') IS NULL
      OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
    )
`,_=async t=>{await e(t,f)||(await t.execute(g),await t.execute(p))},v=[`blocks_references_insert`,`blocks_references_update`,`blocks_references_delete`],y=async t=>{if(!await e(t,m)){for(let e of v)await t.execute(`DROP TRIGGER IF EXISTS ${e}`);await t.execute(`DROP TABLE IF EXISTS block_references`),await t.execute(i),await t.execute(a),await t.execute(o),await t.execute(s),await t.execute(c),await t.execute(l),await t.execute(g),await t.execute(h)}},b={id:`references.local-schema`,statements:[r,i,a,o,s,c,l],triggerNames:v,analyzeTables:[{name:`block_references`,probe:`SELECT target_id FROM block_references WHERE workspace_id = '' AND alias = ''`}],backfills:[{id:`references.block-references-source-field`,run:y},{id:`references.block-references-backfill`,run:_}]};export{g as BACKFILL_BLOCK_REFERENCES_SQL,u as BLOCK_REFERENCES_BACKFILL_MARKER_KEY,d as BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY,v as BLOCK_REFERENCES_TRIGGER_NAMES,l as CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,s as CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,c as CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,r as CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,i as CREATE_BLOCK_REFERENCES_TABLE_SQL,a as CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,o as CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL,p as RECORD_BLOCK_REFERENCES_BACKFILL_DONE_SQL,h as RECORD_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,f as SELECT_BLOCK_REFERENCES_BACKFILL_DONE_SQL,m as SELECT_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,_ as backfillBlockReferencesIfEmpty,y as backfillBlockReferencesSourceFieldIfNeeded,b as referencesLocalSchema};
//# sourceMappingURL=localSchema.js.map