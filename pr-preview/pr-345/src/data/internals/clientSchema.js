import{ALIAS_COLLISION_RAISE_PREFIX as e,PARENT_DELETED_RAISE_PREFIX as t,RAISE_FIELD_SEP_SQL as n}from"./raiseProtocol.js";var r=`
  CREATE TABLE IF NOT EXISTS tx_context (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    tx_id    TEXT,
    tx_seq   INTEGER,
    user_id  TEXT,
    scope    TEXT,
    source   TEXT,
    group_id TEXT
  )
`,i=`
  INSERT OR IGNORE INTO tx_context (id) VALUES (1)
`,a=`
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
`,o=`
  CREATE INDEX IF NOT EXISTS idx_row_events_tx
  ON row_events (tx_id)
`,s=`
  CREATE INDEX IF NOT EXISTS idx_row_events_block
  ON row_events (block_id, created_at DESC)
`,c=`
  CREATE INDEX IF NOT EXISTS idx_row_events_created
  ON row_events (created_at DESC)
`,l=`
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
`,u=`
  CREATE INDEX IF NOT EXISTS idx_command_events_created
  ON command_events (created_at DESC)
`,d=`
  CREATE INDEX IF NOT EXISTS idx_command_events_workspace
  ON command_events (workspace_id, created_at DESC)
`,f=`
  CREATE TABLE IF NOT EXISTS block_aliases (
    block_id     TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    alias_lower  TEXT NOT NULL,
    PRIMARY KEY (block_id, alias)
  )
`,ee=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias
  ON block_aliases (workspace_id, alias)
`,te=`
  CREATE TABLE IF NOT EXISTS client_schema_state (
    key           TEXT PRIMARY KEY,
    completed_at  INTEGER NOT NULL
  )
`,ne=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias_lower
  ON block_aliases (workspace_id, alias_lower)
`,re=`
  DROP INDEX IF EXISTS idx_blocks_workspace_type
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
`,h=`
  CREATE TABLE IF NOT EXISTS blocks_fts_rowids (
    fts_rowid  INTEGER PRIMARY KEY,
    block_id   TEXT NOT NULL UNIQUE
  )
`,g=`
  CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    workspace_id UNINDEXED,
    block_id UNINDEXED,
    tokenize = 'trigram case_sensitive 0'
  )
`,ie=`
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
`,C=`
  CREATE TABLE IF NOT EXISTS pending_restage (
    id TEXT PRIMARY KEY
  )
`,w=`
  CREATE TRIGGER IF NOT EXISTS pending_restage_clear_on_synced_insert
  AFTER INSERT ON blocks_synced
  BEGIN
    DELETE FROM pending_restage WHERE id = NEW.id;
  END
`,T=`
  CREATE TRIGGER IF NOT EXISTS pending_restage_clear_on_synced_delete
  AFTER DELETE ON blocks_synced
  BEGIN
    DELETE FROM pending_restage WHERE id = OLD.id;
  END
`,E=`
  INSERT INTO blocks_synced_changes (id, op)
    SELECT pr.id, 'upsert' FROM pending_restage AS pr
     WHERE EXISTS (SELECT 1 FROM blocks_synced WHERE id = pr.id)
       AND NOT EXISTS (
         SELECT 1 FROM ps_crud
          WHERE json_extract(data, '$.type') = 'blocks'
            AND json_extract(data, '$.id') = pr.id
       )
`,D=`
  DELETE FROM pending_restage
   WHERE NOT EXISTS (
     SELECT 1 FROM ps_crud
      WHERE json_extract(data, '$.type') = 'blocks'
        AND json_extract(data, '$.id') = pending_restage.id
   )
`,ae=async e=>{await e.writeTransaction(async e=>{await e.execute(E),await e.execute(D)})},O=e=>`
      json_object(
        'id', ${e}.id,
        'workspaceId', ${e}.workspace_id,
        'parentId', ${e}.parent_id,
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
`.trim(),k=e=>`
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT ${e} FROM tx_context WHERE id = 1)
      END
`.trim(),A=k(`tx_id`),j=`COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`,M=k(`group_id`),N=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${A},
      NEW.id,
      'create',
      NULL,
      ${O(`NEW`)},
      ${j},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${M}
    );
  END
`,P=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${A},
      NEW.id,
      CASE
        WHEN OLD.deleted = 0 AND NEW.deleted = 1 THEN 'soft-delete'
        ELSE 'update'
      END,
      ${O(`OLD`)},
      ${O(`NEW`)},
      ${j},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${M}
    );
  END
`,F=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${A},
      OLD.id,
      'delete',
      ${O(`OLD`)},
      NULL,
      ${j},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${M}
    );
  END
`,I=[{name:`workspace_id`,jsonValue:e=>`${e}.workspace_id`},{name:`parent_id`,jsonValue:e=>`${e}.parent_id`},{name:`order_key`,jsonValue:e=>`${e}.order_key`},{name:`content`,jsonValue:e=>`${e}.content`},{name:`properties_json`,jsonValue:e=>`${e}.properties_json`},{name:`references_json`,jsonValue:e=>`${e}.references_json`},{name:`created_at`,jsonValue:e=>`${e}.created_at`},{name:`updated_at`,jsonValue:e=>`${e}.updated_at`},{name:`user_updated_at`,jsonValue:e=>`${e}.user_updated_at`},{name:`created_by`,jsonValue:e=>`${e}.created_by`},{name:`updated_by`,jsonValue:e=>`${e}.updated_by`},{name:`deleted`,jsonValue:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],oe=e=>`
      json_object(
${I.map(t=>`        '${t.name}', ${t.jsonValue(e)}`).join(`,
`)}
      )
`.trim(),se=I.map(e=>`OLD.${e.name} IS NOT NEW.${e.name}`).join(`
    OR `),ce=()=>`
      json_remove(
        json_set(
          '{}',
          '$.workspace_id', NEW.workspace_id,
${I.filter(e=>e.name!==`workspace_id`).map(e=>`          CASE WHEN OLD.${e.name} IS NOT NEW.${e.name} THEN '$.${e.name}' ELSE '$.__noop' END, ${e.jsonValue(`NEW`)}`).join(`,
`)}
        ),
        '$.__noop'
      )
`.trim(),L=`(SELECT tx_seq FROM tx_context WHERE id = 1)`,R=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_insert
  AFTER INSERT ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${L},
      json_object(
        'op', 'PUT',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${oe(`NEW`)}
      )
    );
  END
`,z=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND (
    ${se}
    )
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${L},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${ce()}
      )
    );
  END
`,B=`
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
`,V=`
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
`,H=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_insert
  BEFORE INSERT ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${t}' || ${n} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`,U=`
  CREATE TRIGGER IF NOT EXISTS blocks_parent_not_deleted_check_update
  BEFORE UPDATE OF parent_id, deleted ON blocks
  WHEN NEW.parent_id IS NOT NULL
    AND NEW.deleted = 0
    AND (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT,
      '${t}' || ${n} || NEW.parent_id
    )
    WHERE EXISTS (
      SELECT 1 FROM blocks
      WHERE id = NEW.parent_id
        AND deleted = 1
    );
  END
`,W=`
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
`,G=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
    SELECT NEW.id, NEW.workspace_id, je.value, LOWER(je.value)
    FROM json_each(NEW.properties_json, '$.alias') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,K=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = OLD.id;
  END
`,q=`
  CREATE TRIGGER IF NOT EXISTS block_aliases_workspace_alias_unique
  BEFORE INSERT ON block_aliases
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND NEW.alias != ''
  BEGIN
    SELECT RAISE(ABORT,
      '${e}' || ${n} ||
      hex(NEW.workspace_id) || ${n} ||
      hex(NEW.alias) || ${n} ||
      hex(NEW.block_id)
    )
    WHERE EXISTS (
      SELECT 1 FROM block_aliases
      WHERE workspace_id = NEW.workspace_id
        AND alias = NEW.alias
        AND block_id != NEW.block_id
    );
  END
`,J=`
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
`,Y=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
    SELECT NEW.id, NEW.workspace_id, je.value
    FROM json_each(NEW.properties_json, '$.types') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,le=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = OLD.id;
  END
`,ue=e=>`
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
    ${ue(`NEW`)}
  END
`,fe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF content, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    ${ue(`NEW`)}
  END
`,pe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    DELETE FROM blocks_fts_rowids WHERE block_id = OLD.id;
  END
`,X=`block_aliases_backfill_v1`,me=`
  SELECT 1 FROM client_schema_state WHERE key = '${X}'
`,he=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${X}', strftime('%s', 'now') * 1000)
`,ge=`
  INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
  SELECT b.id, b.workspace_id, je.value, LOWER(je.value)
  FROM blocks b, json_each(b.properties_json, '$.alias') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Z=`block_types_backfill_v1`,_e=`
  SELECT 1 FROM client_schema_state WHERE key = '${Z}'
`,ve=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Z}', strftime('%s', 'now') * 1000)
`,ye=`
  INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
  SELECT b.id, b.workspace_id, je.value
  FROM blocks b, json_each(b.properties_json, '$.types') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Q=`blocks_fts_backfill_v1`,be=`
  SELECT 1 FROM client_schema_state WHERE key = '${Q}'
`,xe=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Q}', strftime('%s', 'now') * 1000)
`,Se=`
  INSERT OR IGNORE INTO blocks_fts_rowids (block_id)
  SELECT id
  FROM blocks
  WHERE deleted = 0 AND content != ''
`,Ce=`
  INSERT INTO blocks_fts (rowid, content, workspace_id, block_id)
  SELECT r.fts_rowid, b.content, b.workspace_id, b.id
  FROM blocks b
  JOIN blocks_fts_rowids r ON r.block_id = b.id
  WHERE b.deleted = 0
    AND b.content != ''
    AND NOT EXISTS (
      SELECT 1 FROM blocks_fts WHERE rowid = r.fts_rowid
    )
`,we=1e3,Te=4,Ee=`
  SELECT MAX(CAST(stat AS INTEGER)) AS rows FROM sqlite_stat1 WHERE tbl = 'blocks'
`,De=`
  SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1' LIMIT 1
`,Oe=`SELECT COUNT(*) AS count FROM blocks`,ke=`reproject_ref:`,Ae=`
  SELECT key FROM client_schema_state WHERE key LIKE '${ke}%'
`,je=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Me=`
  DELETE FROM client_schema_state WHERE key = ?
`,Ne=`workspace_backfill:`,Pe=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Ne}%'
`,Fe=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Ie=`reconcile_rescan_v1:`,Le=`
  SELECT key FROM client_schema_state WHERE key = ?
`,Re=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,ze=/^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,Be=e=>e.flatMap(e=>{let t=e.match(ze)?.[1];return t?[`DROP TRIGGER IF EXISTS ${t}`,e]:[e]}),Ve=async(e,t,n,r)=>{await e.execute(`DROP TRIGGER IF EXISTS ${t}`);try{await r()}finally{await e.execute(n)}},He=Be([r,i,a,o,s,c,l,u,d,f,ee,ne,p,m,h,g,te,ie,_,v,y,b,C,re,N,P,F,R,z,B,V,H,U,W,G,K,q,J,Y,le,de,fe,pe,x,S,w,T]),Ue=[`blocks_row_event_insert`,`blocks_row_event_update`,`blocks_row_event_delete`,`blocks_upload_insert`,`blocks_upload_update`,`blocks_parent_workspace_check_insert`,`blocks_parent_workspace_check_update`,`blocks_parent_not_deleted_check_insert`,`blocks_parent_not_deleted_check_update`,`blocks_alias_insert`,`blocks_alias_update`,`blocks_alias_delete`,`block_aliases_workspace_alias_unique`,`blocks_type_insert`,`blocks_type_update`,`blocks_type_delete`,`blocks_fts_insert`,`blocks_fts_update`,`blocks_fts_delete`,`blocks_synced_changes_insert`,`blocks_synced_changes_delete`,`pending_restage_clear_on_synced_insert`,`pending_restage_clear_on_synced_delete`],We=async e=>{await e.getOptional(me)===null&&(await e.execute(ge),await e.execute(he))},Ge=async e=>{await e.getOptional(_e)===null&&(await e.execute(ye),await e.execute(ve))},Ke=async e=>{await e.getOptional(be)===null&&(await e.execute(Se),await e.execute(Ce),await e.execute(xe))},qe=async e=>{let t=!1;for(let n of[`blocks`,`blocks_synced`])(await e.getAll(`PRAGMA table_info(${n})`)).some(e=>e.name===`user_updated_at`)||(await e.execute(`ALTER TABLE ${n} ADD COLUMN user_updated_at INTEGER`),n===`blocks`&&(t=!0));t&&await Ve(e,`blocks_row_event_update`,P,async()=>{await e.execute(`UPDATE blocks SET user_updated_at = updated_at`)})},Je=async e=>{for(let t of[`tx_context`,`row_events`]){let n=await e.getAll(`PRAGMA table_info(${t})`);n.length!==0&&(n.some(e=>e.name===`group_id`)||await e.execute(`ALTER TABLE ${t} ADD COLUMN group_id TEXT`))}},Ye=async e=>await e.getOptional(De)===null?null:(await e.getOptional(Ee))?.rows??null,$=async e=>(await e.getOptional(Oe))?.count??0,Xe=(e,t,n=we,r=4)=>t<n?!1:e===null||t>=e*r||e>=t*r,Ze=async(e,t={})=>{let n=t.minBlocks??1e3,r=t.growthFactor??4,i=await Ye(e),a=await $(e);return Xe(i,a,n,r)?(await e.execute(`ANALYZE`),{analyzed:!0,count:a,previousEstimate:i}):{analyzed:!1,count:a,previousEstimate:i}},Qe=async e=>{let t=await $(e);return await e.execute(`ANALYZE`),{count:t}};export{X as ALIAS_BACKFILL_MARKER_KEY,Te as ANALYZE_GROWTH_FACTOR,we as ANALYZE_MIN_BLOCKS,Se as BACKFILL_BLOCKS_FTS_ROWIDS_SQL,Ce as BACKFILL_BLOCKS_FTS_SQL,ge as BACKFILL_BLOCK_ALIASES_SQL,ye as BACKFILL_BLOCK_TYPES_SQL,Q as BLOCKS_FTS_BACKFILL_MARKER_KEY,Z as BLOCK_TYPES_BACKFILL_MARKER_KEY,Me as CLEAR_REPROJECT_REF_MARKER_SQL,He as CLIENT_SCHEMA_STATEMENTS,Ue as CLIENT_SCHEMA_TRIGGER_NAMES,K as CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL,W as CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL,G as CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL,F as CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,pe as CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL,de as CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,h as CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL,g as CREATE_BLOCKS_FTS_TABLE_SQL,fe as CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL,N as CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,H as CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL,U as CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL,S as CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL,b as CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL,x as CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL,y as CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL,le as CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL,J as CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL,Y as CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL,P as CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,R as CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,z as CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,B as CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,V as CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,f as CREATE_BLOCK_ALIASES_TABLE_SQL,q as CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL,ee as CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL,ne as CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL,p as CREATE_BLOCK_TYPES_TABLE_SQL,m as CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL,te as CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,u as CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL,l as CREATE_COMMAND_EVENTS_TABLE_SQL,d as CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL,T as CREATE_PENDING_RESTAGE_CLEAR_ON_SYNCED_DELETE_TRIGGER_SQL,w as CREATE_PENDING_RESTAGE_CLEAR_ON_SYNCED_INSERT_TRIGGER_SQL,C as CREATE_PENDING_RESTAGE_TABLE_SQL,_ as CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL,ie as CREATE_PS_CRUD_REJECTED_TABLE_SQL,v as CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL,s as CREATE_ROW_EVENTS_BLOCK_INDEX_SQL,c as CREATE_ROW_EVENTS_CREATED_INDEX_SQL,a as CREATE_ROW_EVENTS_TABLE_SQL,o as CREATE_ROW_EVENTS_TX_INDEX_SQL,r as CREATE_TX_CONTEXT_TABLE_SQL,re as DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,D as FLUSH_PENDING_RESTAGE_DELETE_SQL,E as FLUSH_PENDING_RESTAGE_ENQUEUE_SQL,Ie as RECONCILE_RESCAN_MARKER_PREFIX,xe as RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL,he as RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL,ve as RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL,Re as RECORD_RECONCILE_RESCAN_MARKER_SQL,je as RECORD_REPROJECT_REF_MARKER_SQL,Fe as RECORD_WORKSPACE_BACKFILL_MARKER_SQL,ke as REPROJECT_REF_MARKER_PREFIX,i as SEED_TX_CONTEXT_ROW_SQL,Oe as SELECT_BLOCKS_COUNT_SQL,be as SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL,Ee as SELECT_BLOCKS_STAT_ESTIMATE_SQL,me as SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL,_e as SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL,Le as SELECT_RECONCILE_RESCAN_MARKER_SQL,Ae as SELECT_REPROJECT_REF_MARKERS_SQL,De as SELECT_SQLITE_STAT1_EXISTS_SQL,Pe as SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,Ne as WORKSPACE_BACKFILL_MARKER_PREFIX,Xe as analyzeIsWarranted,We as backfillBlockAliasesIfEmpty,Ge as backfillBlockTypesIfEmpty,Ke as backfillBlocksFtsIfEmpty,qe as ensureBlockUserUpdatedAtColumn,Je as ensureUndoGroupIdColumns,ae as flushPendingRestage,$ as getBlocksCount,Ye as getBlocksStatEstimate,Ze as runAnalyzeIfStale,Qe as runAnalyzeNow};
//# sourceMappingURL=clientSchema.js.map