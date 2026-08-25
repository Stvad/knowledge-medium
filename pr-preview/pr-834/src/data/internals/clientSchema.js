import{STAGING_LOCAL_COLUMNS as e}from"../blockSchema.js";import{SEED_STAGING_NEEDS_APPLY_SQL as t}from"./syncObserver/reconcile.js";import{ALIAS_COLLISION_RAISE_PREFIX as n,PARENT_DELETED_RAISE_PREFIX as r,RAISE_FIELD_SEP_SQL as i}from"./raiseProtocol.js";var a=`
  CREATE TABLE IF NOT EXISTS tx_context (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    tx_id    TEXT,
    tx_seq   INTEGER,
    user_id  TEXT,
    scope    TEXT,
    source   TEXT,
    group_id TEXT
  )
`,o=`
  INSERT OR IGNORE INTO tx_context (id) VALUES (1)
`,s=`
  CREATE TABLE IF NOT EXISTS row_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id       TEXT,
    block_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    group_id    TEXT
  )
`,c=`
  CREATE INDEX IF NOT EXISTS idx_row_events_tx
  ON row_events (tx_id)
`,l=`
  CREATE INDEX IF NOT EXISTS idx_row_events_block
  ON row_events (block_id, created_at DESC)
`,u=`
  CREATE INDEX IF NOT EXISTS idx_row_events_created
  ON row_events (created_at DESC)
`,ee=`
  CREATE TABLE IF NOT EXISTS command_events (
    tx_id         TEXT PRIMARY KEY,
    description   TEXT,
    scope         TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    workspace_id  TEXT,
    mutator_calls TEXT NOT NULL,
    source        TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )
`,te=`
  CREATE INDEX IF NOT EXISTS idx_command_events_created
  ON command_events (created_at DESC)
`,ne=`
  CREATE INDEX IF NOT EXISTS idx_command_events_workspace
  ON command_events (workspace_id, created_at DESC)
`,re=`
  CREATE TABLE IF NOT EXISTS block_aliases (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    alias_lower  TEXT NOT NULL,
    PRIMARY KEY (block_id, alias)
  )
`,ie=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias
  ON block_aliases (workspace_id, alias)
`,ae=`
  CREATE TABLE IF NOT EXISTS client_schema_state (
    key           TEXT PRIMARY KEY,
    completed_at  INTEGER NOT NULL
  )
`,oe=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias_lower
  ON block_aliases (workspace_id, alias_lower)
`,d=`
  DROP INDEX IF EXISTS idx_blocks_workspace_type
`,f=String.raw`
  DELETE FROM client_schema_state WHERE key LIKE 'analyze\_index\_set:%' ESCAPE '\'
`,p=`
  CREATE TABLE IF NOT EXISTS block_types (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    type         TEXT NOT NULL,
    PRIMARY KEY (block_id, type)
  )
`,m=`
  CREATE INDEX IF NOT EXISTS idx_block_types_type_workspace
  ON block_types (type, workspace_id)
`,se=`
  CREATE TABLE IF NOT EXISTS blocks_fts_rowids (
    fts_rowid  INTEGER PRIMARY KEY,
    block_id   TEXT NOT NULL UNIQUE
  )
`,h=`
  CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    workspace_id UNINDEXED,
    block_id UNINDEXED,
    tokenize = 'trigram case_sensitive 0'
  )
`,g=`
  CREATE TABLE IF NOT EXISTS ps_crud_rejected (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id   INTEGER NOT NULL,
    tx_id         INTEGER NOT NULL,
    data          TEXT NOT NULL,
    error_code    TEXT,
    error_message TEXT,
    rejected_at   INTEGER NOT NULL
  )
`,_=`
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_rejected_at
  ON ps_crud_rejected (rejected_at DESC)
`,v=`
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_tx_id
  ON ps_crud_rejected (tx_id)
`,y=`
  CREATE TABLE IF NOT EXISTS blocks_synced_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id  TEXT NOT NULL,
    op  TEXT NOT NULL CHECK (op IN ('upsert', 'delete'))
  )
`,b=`
  CREATE INDEX IF NOT EXISTS idx_blocks_synced_changes_id_op
  ON blocks_synced_changes (id, op)
`,x=`
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_insert
  AFTER INSERT ON blocks_synced
  BEGIN
    DELETE FROM blocks_synced_changes WHERE id = NEW.id AND op = 'delete';
    INSERT INTO blocks_synced_changes (id, op) VALUES (NEW.id, 'upsert');
  END
`,S=`
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_delete
  AFTER DELETE ON blocks_synced
  BEGIN
    INSERT INTO blocks_synced_changes (id, op) VALUES (OLD.id, 'delete');
  END
`,C=e=>`
      json_object(
        'id', ${e}.id,
        'workspaceId', ${e}.workspace_id,
        'parentId', ${e}.parent_id,
        'referenceTargetId', ${e}.reference_target_id,
        'isFieldForm', json(CASE WHEN ${e}.is_field_form = 1 THEN 'true' ELSE 'false' END),
        'orderKey', ${e}.order_key,
        'content', ${e}.content,
        'properties', json(${e}.properties_json),
        'references', json(${e}.references_json),
        'createdAt', ${e}.created_at,
        'updatedAt', ${e}.updated_at,
        'userUpdatedAt', coalesce(${e}.user_updated_at, ${e}.updated_at),
        'createdBy', ${e}.created_by,
        'updatedBy', ${e}.updated_by,
        'deleted', json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)
      )
`.trim(),w=e=>`
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT ${e} FROM tx_context WHERE id = 1)
      END
`.trim(),T=w(`tx_id`),E=`COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`,D=w(`group_id`),O=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${T},
      NEW.id,
      'create',
      NULL,
      ${C(`NEW`)},
      ${E},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${D}
    );
  END
`,k=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${T},
      NEW.id,
      CASE
        WHEN OLD.deleted = 0 AND NEW.deleted = 1 THEN 'soft-delete'
        ELSE 'update'
      END,
      ${C(`OLD`)},
      ${C(`NEW`)},
      ${E},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${D}
    );
  END
`,A=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${T},
      OLD.id,
      'delete',
      ${C(`OLD`)},
      NULL,
      ${E},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${D}
    );
  END
`,j=[{name:`workspace_id`,jsonValue:e=>`${e}.workspace_id`},{name:`parent_id`,jsonValue:e=>`${e}.parent_id`},{name:`order_key`,jsonValue:e=>`${e}.order_key`},{name:`content`,jsonValue:e=>`${e}.content`},{name:`properties_json`,jsonValue:e=>`${e}.properties_json`},{name:`references_json`,jsonValue:e=>`${e}.references_json`},{name:`created_at`,jsonValue:e=>`${e}.created_at`},{name:`updated_at`,jsonValue:e=>`${e}.updated_at`},{name:`user_updated_at`,jsonValue:e=>`${e}.user_updated_at`},{name:`created_by`,jsonValue:e=>`${e}.created_by`},{name:`updated_by`,jsonValue:e=>`${e}.updated_by`},{name:`deleted`,jsonValue:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],ce=e=>`
      json_object(
${j.map(t=>`        '${t.name}', ${t.jsonValue(e)}`).join(`,
`)}
      )
`.trim(),le=j.map(e=>`OLD.${e.name} IS NOT NEW.${e.name}`).join(`
    OR `),ue=()=>`
      json_remove(
        json_set(
          '{}',
          '$.workspace_id', NEW.workspace_id,
          '$.base_updated_at', OLD.updated_at,
${j.filter(e=>e.name!==`workspace_id`).map(e=>`          CASE WHEN OLD.${e.name} IS NOT NEW.${e.name} THEN '$.${e.name}' ELSE '$.__noop' END, ${e.jsonValue(`NEW`)}`).join(`,
`)}
        ),
        '$.__noop'
      )
`.trim(),M=`(SELECT tx_seq FROM tx_context WHERE id = 1)`,N=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_insert
  AFTER INSERT ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${M},
      json_object(
        'op', 'PUT',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${ce(`NEW`)}
      )
    );
  END
`,P=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND (
    ${le}
    )
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${M},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${ue()}
      )
    );
  END
`,F=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_workspace_check_insert
  BEFORE INSERT ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND workspace_id = NEW.workspace_id
    );
  END
`,I=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_workspace_check_update
  BEFORE UPDATE OF parent_id, workspace_id ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'parent must exist and share workspace_id')
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND workspace_id = NEW.workspace_id
    );
  END
`,L=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_insert
  BEFORE INSERT ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${r}' || ${i} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`,R=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_update
  BEFORE UPDATE OF parent_id, deleted ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${r}' || ${i} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`,z=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${(e=>`
      INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
      SELECT ${e}.id, ${e}.workspace_id, je.value, LOWER(je.value)
      FROM json_each(${e}.properties_json, '$.alias') AS je
      WHERE typeof(je.value) = 'text';
`.trim())(`NEW`)}
  END
`,B=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
    SELECT NEW.id, NEW.workspace_id, je.value, LOWER(je.value)
    FROM json_each(NEW.properties_json, '$.alias') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,V=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = OLD.id;
  END
`,H=`
  CREATE TRIGGER IF NOT EXISTS block_aliases_workspace_alias_unique
  BEFORE INSERT ON block_aliases
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND NEW.alias != ''
  BEGIN
    SELECT RAISE(ABORT,
      '${n}' || ${i} ||
      hex(NEW.workspace_id) || ${i} ||
      hex(NEW.alias) || ${i} ||
      hex(NEW.block_id)
    )
    WHERE EXISTS (
      SELECT 1 FROM block_aliases
      WHERE workspace_id = NEW.workspace_id
        AND alias = NEW.alias
        AND block_id != NEW.block_id
    );
  END
`,U=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${(e=>`
      INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
      SELECT ${e}.id, ${e}.workspace_id, je.value
      FROM json_each(${e}.properties_json, '$.types') AS je
      WHERE typeof(je.value) = 'text';
`.trim())(`NEW`)}
  END
`,W=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
    SELECT NEW.id, NEW.workspace_id, je.value
    FROM json_each(NEW.properties_json, '$.types') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,G=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = OLD.id;
  END
`,K=e=>`
      INSERT INTO blocks_fts_rowids (block_id)
      SELECT ${e}.id
      WHERE NOT EXISTS (
        SELECT 1 FROM blocks_fts_rowids WHERE block_id = ${e}.id
      );
      INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
      SELECT fts_rowid, ${e}.content, ${e}.workspace_id, ${e}.id
      FROM blocks_fts_rowids
      WHERE block_id = ${e}.id
        AND ${e}.deleted = 0
        AND ${e}.content != '';
`.trim(),de=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_insert
  AFTER INSERT ON blocks
  BEGIN
    ${K(`NEW`)}
  END
`,fe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF content, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    ${K(`NEW`)}
  END
`,q=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    DELETE FROM blocks_fts_rowids WHERE block_id = OLD.id;
  END
`,J=`block_aliases_backfill_v1`,pe=`
  SELECT 1 FROM client_schema_state WHERE key = '${J}'
`,me=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${J}', strftime('%s', 'now') * 1000)
`,he=`
  INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
  SELECT b.id, b.workspace_id, je.value, LOWER(je.value)
  FROM blocks b, json_each(b.properties_json, '$.alias') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Y=`block_types_backfill_v1`,ge=`
  SELECT 1 FROM client_schema_state WHERE key = '${Y}'
`,_e=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Y}', strftime('%s', 'now') * 1000)
`,ve=`
  INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
  SELECT b.id, b.workspace_id, je.value
  FROM blocks b, json_each(b.properties_json, '$.types') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,X=`blocks_fts_backfill_v1`,Z=`staging_needs_apply_seeded`,ye=`
  SELECT 1 FROM client_schema_state WHERE key = '${Z}'
`,be=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Z}', strftime('%s', 'now') * 1000)
`,xe=`
  SELECT 1 FROM client_schema_state WHERE key = '${X}'
`,Se=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${X}', strftime('%s', 'now') * 1000)
`,Ce=`
  INSERT OR IGNORE INTO blocks_fts_rowids (block_id)
  SELECT id
  FROM blocks
  WHERE deleted = 0 AND content != ''
`,we=`
  INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
  SELECT r.fts_rowid, b.content, b.workspace_id, b.id
  FROM blocks b
  JOIN blocks_fts_rowids r ON r.block_id = b.id
  WHERE b.deleted = 0
    AND b.content != ''
    AND NOT EXISTS (
      SELECT 1 FROM blocks_fts WHERE rowid = r.fts_rowid
    )
`,Te=`PRAGMA optimize(0x03)`,Ee=`PRAGMA optimize(0x02)`,Q=`PRAGMA analysis_limit=0`,De=`PRAGMA analysis_limit`,$=`analyze_unbounded_stats_v1`,Oe=`
  SELECT 1 FROM client_schema_state WHERE key = '${$}'
`,ke=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${$}', strftime('%s', 'now') * 1000)
`,Ae=`SELECT COUNT(*) AS count FROM blocks`,je=[`SELECT id FROM blocks WHERE workspace_id = '' AND deleted = 0`,`SELECT target_id FROM block_references WHERE workspace_id = '' AND alias = ''`,`SELECT block_id FROM block_types WHERE type = '' AND workspace_id = ''`,`SELECT block_id FROM block_aliases WHERE workspace_id = '' AND alias = ''`],Me=`reproject_ref:`,Ne=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Me}%'
`,Pe=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Fe=`
  DELETE FROM client_schema_state WHERE key = ?
`,Ie=`workspace_backfill:`,Le=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Ie}%'
`,Re=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,ze=`reconcile_rescan_v1:`,Be=`
  SELECT key FROM client_schema_state WHERE key = ?
`,Ve=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,He=/^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,Ue=e=>e.flatMap(e=>{let t=e.match(He)?.[1];return t?[`DROP TRIGGER IF EXISTS ${t}`,e]:[e]}),We=async(e,t,n,r)=>{await e.execute(`DROP TRIGGER IF EXISTS ${t}`);try{await r()}finally{await e.execute(n)}},Ge=Ue([a,o,s,c,l,u,ee,te,ne,re,ie,oe,p,m,se,h,ae,g,_,v,y,b,d,f,O,k,A,N,P,F,I,L,R,z,B,V,H,U,W,G,de,fe,q,x,S]),Ke=[`blocks_row_event_insert`,`blocks_row_event_update`,`blocks_row_event_delete`,`blocks_upload_insert`,`blocks_upload_update`,`blocks_parent_workspace_check_insert`,`blocks_parent_workspace_check_update`,`blocks_parent_not_deleted_check_insert`,`blocks_parent_not_deleted_check_update`,`blocks_alias_insert`,`blocks_alias_update`,`blocks_alias_delete`,`block_aliases_workspace_alias_unique`,`blocks_type_insert`,`blocks_type_update`,`blocks_type_delete`,`blocks_fts_insert`,`blocks_fts_update`,`blocks_fts_delete`,`blocks_synced_changes_insert`,`blocks_synced_changes_delete`],qe=async e=>{await e.getOptional(pe)===null&&(await e.execute(he),await e.execute(me))},Je=async e=>{await e.getOptional(ge)===null&&(await e.execute(ve),await e.execute(_e))},Ye=async e=>{await e.getOptional(xe)===null&&(await e.execute(Ce),await e.execute(we),await e.execute(Se))},Xe=async e=>{let t=!1;for(let n of[`blocks`,`blocks_synced`])(await e.getAll(`PRAGMA table_info(${n})`)).some(e=>e.name===`user_updated_at`)||(await e.execute(`ALTER TABLE ${n} ADD COLUMN user_updated_at INTEGER`),n===`blocks`&&(t=!0));t&&await We(e,`blocks_row_event_update`,k,async()=>{await e.execute(`UPDATE blocks SET user_updated_at = updated_at`)})},Ze=async n=>{let r=await n.getAll(`PRAGMA table_info(blocks_synced)`);if(r.length!==0){for(let t of e)r.some(e=>e.name===t.name)||await n.execute(`ALTER TABLE blocks_synced ADD COLUMN ${t.definition}`);await n.getOptional(ye)===null&&(await n.execute(t),await n.execute(be))}},Qe=async e=>{for(let t of[`tx_context`,`row_events`]){let n=await e.getAll(`PRAGMA table_info(${t})`);n.length!==0&&(n.some(e=>e.name===`group_id`)||await e.execute(`ALTER TABLE ${t} ADD COLUMN group_id TEXT`))}},$e=async e=>(await e.getOptional(Ae))?.count??0,et=async e=>{for(let t of je)try{await e.execute(`EXPLAIN QUERY PLAN ${t}`)}catch(e){console.warn(`[clientSchema] ANALYZE arming probe failed:`,t,e)}},tt=e=>{let t=e?.rows?._array;return Array.isArray(t)?t.map(e=>e.optimize).filter(e=>typeof e==`string`):null},nt=Promise.resolve(),rt=e=>{let t=nt.then(e,e);return nt=t,t},it=async e=>rt(async()=>{await et(e);let t=tt(await e.execute(Te));return await e.execute(Q),await e.execute(Ee),{proposed:t,repaired:await at(e)}}),at=async e=>await e.getOptional(Oe)!==null||(await e.execute(Q),await e.execute(`ANALYZE`),await ot(e)!==0)?!1:(await e.execute(ke),!0),ot=async e=>(await e.getOptional(De))?.analysis_limit??0,st=async e=>rt(async()=>{let t=await $e(e);return await e.execute(Q),await e.execute(`ANALYZE`),{count:t}});export{J as ALIAS_BACKFILL_MARKER_KEY,je as ANALYZE_ARMING_PROBES,Te as ANALYZE_DRY_RUN_SQL,Ee as ANALYZE_OPTIMIZE_SQL,Ce as BACKFILL_BLOCKS_FTS_ROWIDS_SQL,we as BACKFILL_BLOCKS_FTS_SQL,he as BACKFILL_BLOCK_ALIASES_SQL,ve as BACKFILL_BLOCK_TYPES_SQL,X as BLOCKS_FTS_BACKFILL_MARKER_KEY,Y as BLOCK_TYPES_BACKFILL_MARKER_KEY,Fe as CLEAR_REPROJECT_REF_MARKER_SQL,Ge as CLIENT_SCHEMA_STATEMENTS,Ke as CLIENT_SCHEMA_TRIGGER_NAMES,V as CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL,z as CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL,B as CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL,A as CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,q as CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL,de as CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,se as CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL,h as CREATE_BLOCKS_FTS_TABLE_SQL,fe as CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL,O as CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,L as CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL,R as CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL,S as CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL,b as CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL,x as CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL,y as CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL,G as CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL,U as CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL,W as CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL,k as CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,N as CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,P as CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,F as CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,I as CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,re as CREATE_BLOCK_ALIASES_TABLE_SQL,H as CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL,ie as CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL,oe as CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL,p as CREATE_BLOCK_TYPES_TABLE_SQL,m as CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL,ae as CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,te as CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL,ee as CREATE_COMMAND_EVENTS_TABLE_SQL,ne as CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL,_ as CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL,g as CREATE_PS_CRUD_REJECTED_TABLE_SQL,v as CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL,l as CREATE_ROW_EVENTS_BLOCK_INDEX_SQL,u as CREATE_ROW_EVENTS_CREATED_INDEX_SQL,s as CREATE_ROW_EVENTS_TABLE_SQL,c as CREATE_ROW_EVENTS_TX_INDEX_SQL,a as CREATE_TX_CONTEXT_TABLE_SQL,f as DROP_ANALYZE_INDEX_SET_MARKERS_SQL,d as DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,De as READ_ANALYZE_SAMPLE_LIMIT_SQL,ze as RECONCILE_RESCAN_MARKER_PREFIX,Se as RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL,me as RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL,_e as RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL,Ve as RECORD_RECONCILE_RESCAN_MARKER_SQL,Pe as RECORD_REPROJECT_REF_MARKER_SQL,be as RECORD_STAGING_NEEDS_APPLY_SEEDED_SQL,ke as RECORD_UNBOUNDED_ANALYZE_DONE_SQL,Re as RECORD_WORKSPACE_BACKFILL_MARKER_SQL,Me as REPROJECT_REF_MARKER_PREFIX,Q as RESET_ANALYZE_SAMPLE_LIMIT_SQL,o as SEED_TX_CONTEXT_ROW_SQL,Ae as SELECT_BLOCKS_COUNT_SQL,xe as SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL,pe as SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL,ge as SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL,Be as SELECT_RECONCILE_RESCAN_MARKER_SQL,Ne as SELECT_REPROJECT_REF_MARKERS_SQL,ye as SELECT_STAGING_NEEDS_APPLY_SEEDED_SQL,Oe as SELECT_UNBOUNDED_ANALYZE_DONE_SQL,Le as SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,Z as STAGING_NEEDS_APPLY_SEEDED_MARKER_KEY,$ as UNBOUNDED_ANALYZE_MARKER_KEY,Ie as WORKSPACE_BACKFILL_MARKER_PREFIX,qe as backfillBlockAliasesIfEmpty,Je as backfillBlockTypesIfEmpty,Ye as backfillBlocksFtsIfEmpty,Xe as ensureBlockUserUpdatedAtColumn,Ze as ensureStagingNeedsApplyColumn,Qe as ensureUndoGroupIdColumns,$e as getBlocksCount,it as runAnalyzeIfStale,st as runAnalyzeNow};
//# sourceMappingURL=clientSchema.js.map