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
`,se=`
  DROP INDEX IF EXISTS idx_blocks_workspace_type
`,d=String.raw`
  DELETE FROM client_schema_state WHERE key LIKE 'analyze\_index\_set:%' ESCAPE '\'
`,f=`
  CREATE TABLE IF NOT EXISTS block_types (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    type         TEXT NOT NULL,
    PRIMARY KEY (block_id, type)
  )
`,p=`
  CREATE INDEX IF NOT EXISTS idx_block_types_type_workspace
  ON block_types (type, workspace_id)
`,m=`
  CREATE TABLE IF NOT EXISTS blocks_fts_rowids (
    fts_rowid  INTEGER PRIMARY KEY,
    block_id   TEXT NOT NULL UNIQUE
  )
`,ce=`
  CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    workspace_id UNINDEXED,
    block_id UNINDEXED,
    tokenize = 'trigram case_sensitive 0'
  )
`,h=`
  CREATE TABLE IF NOT EXISTS ps_crud_rejected (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id   INTEGER NOT NULL,
    tx_id         INTEGER NOT NULL,
    data          TEXT NOT NULL,
    error_code    TEXT,
    error_message TEXT,
    rejected_at   INTEGER NOT NULL
  )
`,g=`
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_rejected_at
  ON ps_crud_rejected (rejected_at DESC)
`,_=`
  CREATE INDEX IF NOT EXISTS idx_ps_crud_rejected_tx_id
  ON ps_crud_rejected (tx_id)
`,v=`
  CREATE TABLE IF NOT EXISTS blocks_synced_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id  TEXT NOT NULL,
    op  TEXT NOT NULL CHECK (op IN ('upsert', 'delete'))
  )
`,y=`
  CREATE INDEX IF NOT EXISTS idx_blocks_synced_changes_id_op
  ON blocks_synced_changes (id, op)
`,b=`
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_insert
  AFTER INSERT ON blocks_synced
  BEGIN
    DELETE FROM blocks_synced_changes WHERE id = NEW.id AND op = 'delete';
    INSERT INTO blocks_synced_changes (id, op) VALUES (NEW.id, 'upsert');
  END
`,x=`
  CREATE TRIGGER IF NOT EXISTS blocks_synced_changes_delete
  AFTER DELETE ON blocks_synced
  BEGIN
    INSERT INTO blocks_synced_changes (id, op) VALUES (OLD.id, 'delete');
  END
`,S=e=>`
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
`.trim(),C=e=>`
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT ${e} FROM tx_context WHERE id = 1)
      END
`.trim(),w=C(`tx_id`),T=`COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`,E=C(`group_id`),D=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${w},
      NEW.id,
      'create',
      NULL,
      ${S(`NEW`)},
      ${T},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${E}
    );
  END
`,O=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${w},
      NEW.id,
      CASE
        WHEN OLD.deleted = 0 AND NEW.deleted = 1 THEN 'soft-delete'
        ELSE 'update'
      END,
      ${S(`OLD`)},
      ${S(`NEW`)},
      ${T},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${E}
    );
  END
`,k=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${w},
      OLD.id,
      'delete',
      ${S(`OLD`)},
      NULL,
      ${T},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${E}
    );
  END
`,A=[{name:`workspace_id`,jsonValue:e=>`${e}.workspace_id`},{name:`parent_id`,jsonValue:e=>`${e}.parent_id`},{name:`order_key`,jsonValue:e=>`${e}.order_key`},{name:`content`,jsonValue:e=>`${e}.content`},{name:`properties_json`,jsonValue:e=>`${e}.properties_json`},{name:`references_json`,jsonValue:e=>`${e}.references_json`},{name:`created_at`,jsonValue:e=>`${e}.created_at`},{name:`updated_at`,jsonValue:e=>`${e}.updated_at`},{name:`user_updated_at`,jsonValue:e=>`${e}.user_updated_at`},{name:`created_by`,jsonValue:e=>`${e}.created_by`},{name:`updated_by`,jsonValue:e=>`${e}.updated_by`},{name:`deleted`,jsonValue:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],le=e=>`
      json_object(
${A.map(t=>`        '${t.name}', ${t.jsonValue(e)}`).join(`,
`)}
      )
`.trim(),ue=A.map(e=>`OLD.${e.name} IS NOT NEW.${e.name}`).join(`
    OR `),de=()=>`
      json_remove(
        json_set(
          '{}',
          '$.workspace_id', NEW.workspace_id,
          '$.base_updated_at', OLD.updated_at,
${A.filter(e=>e.name!==`workspace_id`).map(e=>`          CASE WHEN OLD.${e.name} IS NOT NEW.${e.name} THEN '$.${e.name}' ELSE '$.__noop' END, ${e.jsonValue(`NEW`)}`).join(`,
`)}
        ),
        '$.__noop'
      )
`.trim(),j=`(SELECT tx_seq FROM tx_context WHERE id = 1)`,M=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_insert
  AFTER INSERT ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${j},
      json_object(
        'op', 'PUT',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${le(`NEW`)}
      )
    );
  END
`,N=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND (
    ${ue}
    )
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${j},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${de()}
      )
    );
  END
`,P=`
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
`,F=`
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
`,I=`
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
`,L=`
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
`,R=`
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
`,z=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
    SELECT NEW.id, NEW.workspace_id, je.value, LOWER(je.value)
    FROM json_each(NEW.properties_json, '$.alias') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,B=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = OLD.id;
  END
`,V=`
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
`,H=`
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
`,U=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
    SELECT NEW.id, NEW.workspace_id, je.value
    FROM json_each(NEW.properties_json, '$.types') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,W=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = OLD.id;
  END
`,G=e=>`
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
`.trim(),fe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_insert
  AFTER INSERT ON blocks
  BEGIN
    ${G(`NEW`)}
  END
`,pe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF content, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    ${G(`NEW`)}
  END
`,K=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    DELETE FROM blocks_fts_rowids WHERE block_id = OLD.id;
  END
`,q=`block_aliases_backfill_v1`,me=`
  SELECT 1 FROM client_schema_state WHERE key = '${q}'
`,he=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${q}', strftime('%s', 'now') * 1000)
`,ge=`
  INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
  SELECT b.id, b.workspace_id, je.value, LOWER(je.value)
  FROM blocks b, json_each(b.properties_json, '$.alias') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,J=`block_types_backfill_v1`,_e=`
  SELECT 1 FROM client_schema_state WHERE key = '${J}'
`,ve=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${J}', strftime('%s', 'now') * 1000)
`,ye=`
  INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
  SELECT b.id, b.workspace_id, je.value
  FROM blocks b, json_each(b.properties_json, '$.types') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Y=`blocks_fts_backfill_v1`,X=`staging_needs_apply_seeded`,be=`
  SELECT 1 FROM client_schema_state WHERE key = '${X}'
`,xe=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${X}', strftime('%s', 'now') * 1000)
`,Se=`
  SELECT 1 FROM client_schema_state WHERE key = '${Y}'
`,Ce=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Y}', strftime('%s', 'now') * 1000)
`,we=`
  INSERT OR IGNORE INTO blocks_fts_rowids (block_id)
  SELECT id
  FROM blocks
  WHERE deleted = 0 AND content != ''
`,Te=`
  INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
  SELECT r.fts_rowid, b.content, b.workspace_id, b.id
  FROM blocks b
  JOIN blocks_fts_rowids r ON r.block_id = b.id
  WHERE b.deleted = 0
    AND b.content != ''
    AND NOT EXISTS (
      SELECT 1 FROM blocks_fts WHERE rowid = r.fts_rowid
    )
`,Ee=`PRAGMA optimize(0x03)`,De=`PRAGMA optimize(0x02)`,Oe=`PRAGMA analysis_limit=0`,Z=`analyze_unbounded_stats_v1`,ke=`
  SELECT 1 FROM client_schema_state WHERE key = '${Z}'
`,Ae=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Z}', strftime('%s', 'now') * 1000)
`,je=`SELECT COUNT(*) AS count FROM blocks`,Me=[`SELECT id FROM blocks WHERE workspace_id = '' AND deleted = 0`,`SELECT target_id FROM block_references WHERE workspace_id = '' AND alias = ''`,`SELECT block_id FROM block_types WHERE type = '' AND workspace_id = ''`,`SELECT block_id FROM block_aliases WHERE workspace_id = '' AND alias = ''`],Ne=`reproject_ref:`,Pe=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Ne}%'
`,Fe=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Ie=`
  DELETE FROM client_schema_state WHERE key = ?
`,Le=`workspace_backfill:`,Re=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Le}%'
`,ze=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Be=`reconcile_rescan_v1:`,Ve=`
  SELECT key FROM client_schema_state WHERE key = ?
`,He=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Ue=/^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,We=e=>e.flatMap(e=>{let t=e.match(Ue)?.[1];return t?[`DROP TRIGGER IF EXISTS ${t}`,e]:[e]}),Ge=async(e,t,n,r)=>{await e.execute(`DROP TRIGGER IF EXISTS ${t}`);try{await r()}finally{await e.execute(n)}},Ke=We([a,o,s,c,l,u,ee,te,ne,re,ie,oe,f,p,m,ce,ae,h,g,_,v,y,se,d,D,O,k,M,N,P,F,I,L,R,z,B,V,H,U,W,fe,pe,K,b,x]),qe=[`blocks_row_event_insert`,`blocks_row_event_update`,`blocks_row_event_delete`,`blocks_upload_insert`,`blocks_upload_update`,`blocks_parent_workspace_check_insert`,`blocks_parent_workspace_check_update`,`blocks_parent_not_deleted_check_insert`,`blocks_parent_not_deleted_check_update`,`blocks_alias_insert`,`blocks_alias_update`,`blocks_alias_delete`,`block_aliases_workspace_alias_unique`,`blocks_type_insert`,`blocks_type_update`,`blocks_type_delete`,`blocks_fts_insert`,`blocks_fts_update`,`blocks_fts_delete`,`blocks_synced_changes_insert`,`blocks_synced_changes_delete`],Je=async e=>{await e.getOptional(me)===null&&(await e.execute(ge),await e.execute(he))},Ye=async e=>{await e.getOptional(_e)===null&&(await e.execute(ye),await e.execute(ve))},Xe=async e=>{await e.getOptional(Se)===null&&(await e.execute(we),await e.execute(Te),await e.execute(Ce))},Ze=async e=>{let t=!1;for(let n of[`blocks`,`blocks_synced`])(await e.getAll(`PRAGMA table_info(${n})`)).some(e=>e.name===`user_updated_at`)||(await e.execute(`ALTER TABLE ${n} ADD COLUMN user_updated_at INTEGER`),n===`blocks`&&(t=!0));t&&await Ge(e,`blocks_row_event_update`,O,async()=>{await e.execute(`UPDATE blocks SET user_updated_at = updated_at`)})},Qe=async n=>{let r=await n.getAll(`PRAGMA table_info(blocks_synced)`);if(r.length!==0){for(let t of e)r.some(e=>e.name===t.name)||await n.execute(`ALTER TABLE blocks_synced ADD COLUMN ${t.definition}`);await n.getOptional(be)===null&&(await n.execute(t),await n.execute(xe))}},$e=async e=>{for(let t of[`tx_context`,`row_events`]){let n=await e.getAll(`PRAGMA table_info(${t})`);n.length!==0&&(n.some(e=>e.name===`group_id`)||await e.execute(`ALTER TABLE ${t} ADD COLUMN group_id TEXT`))}},et=async e=>(await e.getOptional(je))?.count??0,tt=async e=>{for(let t of Me)try{await e.execute(`EXPLAIN QUERY PLAN ${t}`)}catch(e){console.warn(`[clientSchema] ANALYZE arming probe failed:`,t,e)}},nt=e=>{let t=e?.rows?._array;return Array.isArray(t)?t.map(e=>e.optimize).filter(e=>typeof e==`string`):null},rt=Promise.resolve(),Q=e=>{let t=rt.then(e,e);return rt=t,t},it=async e=>Q(async()=>{await tt(e);let t=nt(await e.execute(Ee));return await $(e,De),{proposed:t}}),$=async(e,t)=>{await e.execute(Oe),await e.execute(t)},at=async e=>Q(async()=>await e.getOptional(ke)===null?(await $(e,`ANALYZE`),await e.execute(Ae),!0):!1),ot=async e=>Q(async()=>{let t=await et(e);return await $(e,`ANALYZE`),{count:t}});export{q as ALIAS_BACKFILL_MARKER_KEY,Me as ANALYZE_ARMING_PROBES,Ee as ANALYZE_DRY_RUN_SQL,De as ANALYZE_OPTIMIZE_SQL,we as BACKFILL_BLOCKS_FTS_ROWIDS_SQL,Te as BACKFILL_BLOCKS_FTS_SQL,ge as BACKFILL_BLOCK_ALIASES_SQL,ye as BACKFILL_BLOCK_TYPES_SQL,Y as BLOCKS_FTS_BACKFILL_MARKER_KEY,J as BLOCK_TYPES_BACKFILL_MARKER_KEY,Ie as CLEAR_REPROJECT_REF_MARKER_SQL,Ke as CLIENT_SCHEMA_STATEMENTS,qe as CLIENT_SCHEMA_TRIGGER_NAMES,B as CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL,R as CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL,z as CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL,k as CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,K as CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL,fe as CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,m as CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL,ce as CREATE_BLOCKS_FTS_TABLE_SQL,pe as CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL,D as CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,I as CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL,L as CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL,x as CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL,y as CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL,b as CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL,v as CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL,W as CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL,H as CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL,U as CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL,O as CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,M as CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,N as CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,P as CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,F as CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,re as CREATE_BLOCK_ALIASES_TABLE_SQL,V as CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL,ie as CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL,oe as CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL,f as CREATE_BLOCK_TYPES_TABLE_SQL,p as CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL,ae as CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,te as CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL,ee as CREATE_COMMAND_EVENTS_TABLE_SQL,ne as CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL,g as CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL,h as CREATE_PS_CRUD_REJECTED_TABLE_SQL,_ as CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL,l as CREATE_ROW_EVENTS_BLOCK_INDEX_SQL,u as CREATE_ROW_EVENTS_CREATED_INDEX_SQL,s as CREATE_ROW_EVENTS_TABLE_SQL,c as CREATE_ROW_EVENTS_TX_INDEX_SQL,a as CREATE_TX_CONTEXT_TABLE_SQL,d as DROP_ANALYZE_INDEX_SET_MARKERS_SQL,se as DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,Be as RECONCILE_RESCAN_MARKER_PREFIX,Ce as RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL,he as RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL,ve as RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL,He as RECORD_RECONCILE_RESCAN_MARKER_SQL,Fe as RECORD_REPROJECT_REF_MARKER_SQL,xe as RECORD_STAGING_NEEDS_APPLY_SEEDED_SQL,Ae as RECORD_UNBOUNDED_ANALYZE_DONE_SQL,ze as RECORD_WORKSPACE_BACKFILL_MARKER_SQL,Ne as REPROJECT_REF_MARKER_PREFIX,Oe as RESET_ANALYZE_SAMPLE_LIMIT_SQL,o as SEED_TX_CONTEXT_ROW_SQL,je as SELECT_BLOCKS_COUNT_SQL,Se as SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL,me as SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL,_e as SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL,Ve as SELECT_RECONCILE_RESCAN_MARKER_SQL,Pe as SELECT_REPROJECT_REF_MARKERS_SQL,be as SELECT_STAGING_NEEDS_APPLY_SEEDED_SQL,ke as SELECT_UNBOUNDED_ANALYZE_DONE_SQL,Re as SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,X as STAGING_NEEDS_APPLY_SEEDED_MARKER_KEY,Z as UNBOUNDED_ANALYZE_MARKER_KEY,Le as WORKSPACE_BACKFILL_MARKER_PREFIX,Je as backfillBlockAliasesIfEmpty,Ye as backfillBlockTypesIfEmpty,Xe as backfillBlocksFtsIfEmpty,Ze as ensureBlockUserUpdatedAtColumn,Qe as ensureStagingNeedsApplyColumn,$e as ensureUndoGroupIdColumns,et as getBlocksCount,it as runAnalyzeIfStale,ot as runAnalyzeNow,at as runSampledStatsRepair};
//# sourceMappingURL=clientSchema.js.map