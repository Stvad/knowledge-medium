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
`,p=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias
  ON block_aliases (workspace_id, alias)
`,ee=`
  CREATE TABLE IF NOT EXISTS client_schema_state (
    key           TEXT PRIMARY KEY,
    completed_at  INTEGER NOT NULL
  )
`,te=`
  CREATE INDEX IF NOT EXISTS idx_block_aliases_ws_alias_lower
  ON block_aliases (workspace_id, alias_lower)
`,ne=`
  DROP INDEX IF EXISTS idx_blocks_workspace_type
`,re=`
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
`,_=`
  CREATE TABLE IF NOT EXISTS ps_crud_rejected (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id   INTEGER NOT NULL,
    tx_id         INTEGER NOT NULL,
    data          TEXT NOT NULL,
    error_code    TEXT,
    error_message TEXT,
    rejected_at   INTEGER NOT NULL
  )
`,ie=`
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
`,w=e=>`NOT EXISTS (
      SELECT 1 FROM ps_crud
       WHERE json_extract(data, '$.type') = 'blocks'
         AND json_extract(data, '$.id') = ${e}
    )`,T=`
  CREATE TRIGGER IF NOT EXISTS pending_restage_clear_on_synced_insert
  AFTER INSERT ON blocks_synced
  BEGIN
    DELETE FROM pending_restage
     WHERE id = NEW.id AND ${w(`NEW.id`)};
  END
`,E=`
  CREATE TRIGGER IF NOT EXISTS pending_restage_clear_on_synced_delete
  AFTER DELETE ON blocks_synced
  BEGIN
    DELETE FROM pending_restage
     WHERE id = OLD.id AND ${w(`OLD.id`)};
  END
`,D=`
  INSERT INTO blocks_synced_changes (id, op)
    SELECT pr.id, 'upsert' FROM pending_restage AS pr
     WHERE EXISTS (SELECT 1 FROM blocks_synced WHERE id = pr.id)
       AND ${w(`pr.id`)}
`,O=`
  DELETE FROM pending_restage
   WHERE ${w(`pending_restage.id`)}
`,ae=async e=>{await e.writeTransaction(async e=>{await e.execute(D),await e.execute(O)})},k=e=>`
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
`.trim(),A=e=>`
      CASE
        WHEN (SELECT source FROM tx_context WHERE id = 1) IS NULL
          THEN NULL
        ELSE (SELECT ${e} FROM tx_context WHERE id = 1)
      END
`.trim(),j=A(`tx_id`),M=`COALESCE((SELECT source FROM tx_context WHERE id = 1), 'sync')`,N=A(`group_id`),P=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_insert
  AFTER INSERT ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${j},
      NEW.id,
      'create',
      NULL,
      ${k(`NEW`)},
      ${M},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${N}
    );
  END
`,F=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_update
  AFTER UPDATE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${j},
      NEW.id,
      CASE
        WHEN OLD.deleted = 0 AND NEW.deleted = 1 THEN 'soft-delete'
        ELSE 'update'
      END,
      ${k(`OLD`)},
      ${k(`NEW`)},
      ${M},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${N}
    );
  END
`,I=`
  CREATE TRIGGER IF NOT EXISTS blocks_row_event_delete
  AFTER DELETE ON blocks
  BEGIN
    INSERT INTO row_events (
      tx_id, block_id, kind, before_json, after_json, source, created_at, group_id
    ) VALUES (
      ${j},
      OLD.id,
      'delete',
      ${k(`OLD`)},
      NULL,
      ${M},
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      ${N}
    );
  END
`,L=[{name:`workspace_id`,jsonValue:e=>`${e}.workspace_id`},{name:`parent_id`,jsonValue:e=>`${e}.parent_id`},{name:`order_key`,jsonValue:e=>`${e}.order_key`},{name:`content`,jsonValue:e=>`${e}.content`},{name:`properties_json`,jsonValue:e=>`${e}.properties_json`},{name:`references_json`,jsonValue:e=>`${e}.references_json`},{name:`created_at`,jsonValue:e=>`${e}.created_at`},{name:`updated_at`,jsonValue:e=>`${e}.updated_at`},{name:`user_updated_at`,jsonValue:e=>`${e}.user_updated_at`},{name:`created_by`,jsonValue:e=>`${e}.created_by`},{name:`updated_by`,jsonValue:e=>`${e}.updated_by`},{name:`deleted`,jsonValue:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],oe=e=>`
      json_object(
${L.map(t=>`        '${t.name}', ${t.jsonValue(e)}`).join(`,
`)}
      )
`.trim(),se=L.map(e=>`OLD.${e.name} IS NOT NEW.${e.name}`).join(`
    OR `),ce=()=>`
      json_remove(
        json_set(
          '{}',
          '$.workspace_id', NEW.workspace_id,
${L.filter(e=>e.name!==`workspace_id`).map(e=>`          CASE WHEN OLD.${e.name} IS NOT NEW.${e.name} THEN '$.${e.name}' ELSE '$.__noop' END, ${e.jsonValue(`NEW`)}`).join(`,
`)}
        ),
        '$.__noop'
      )
`.trim(),R=`(SELECT tx_seq FROM tx_context WHERE id = 1)`,z=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_insert
  AFTER INSERT ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${R},
      json_object(
        'op', 'PUT',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${oe(`NEW`)}
      )
    );
  END
`,B=`
  CREATE TRIGGER IF NOT EXISTS blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
    AND (
    ${se}
    )
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      ${R},
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', ${ce()}
      )
    );
  END
`,V=`
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
`,H=`
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
`,U=`
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
`,W=`
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
`,G=`
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
`,K=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
    SELECT NEW.id, NEW.workspace_id, je.value, LOWER(je.value)
    FROM json_each(NEW.properties_json, '$.alias') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,q=`
  CREATE TRIGGER IF NOT EXISTS blocks_alias_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_aliases WHERE block_id = OLD.id;
  END
`,J=`
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
`,Y=`
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
`,le=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_update
  AFTER UPDATE OF properties_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = NEW.id;
    INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
    SELECT NEW.id, NEW.workspace_id, je.value
    FROM json_each(NEW.properties_json, '$.types') AS je
    WHERE NEW.deleted = 0 AND typeof(je.value) = 'text';
  END
`,ue=`
  CREATE TRIGGER IF NOT EXISTS blocks_type_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_types WHERE block_id = OLD.id;
  END
`,de=e=>`
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
    ${de(`NEW`)}
  END
`,pe=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_update
  AFTER UPDATE OF content, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    ${de(`NEW`)}
  END
`,me=`
  CREATE TRIGGER IF NOT EXISTS blocks_fts_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (
      SELECT fts_rowid FROM blocks_fts_rowids WHERE block_id = OLD.id
    );
    DELETE FROM blocks_fts_rowids WHERE block_id = OLD.id;
  END
`,X=`block_aliases_backfill_v1`,he=`
  SELECT 1 FROM client_schema_state WHERE key = '${X}'
`,ge=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${X}', strftime('%s', 'now') * 1000)
`,_e=`
  INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower)
  SELECT b.id, b.workspace_id, je.value, LOWER(je.value)
  FROM blocks b, json_each(b.properties_json, '$.alias') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Z=`block_types_backfill_v1`,ve=`
  SELECT 1 FROM client_schema_state WHERE key = '${Z}'
`,ye=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Z}', strftime('%s', 'now') * 1000)
`,be=`
  INSERT OR IGNORE INTO block_types (block_id, workspace_id, type)
  SELECT b.id, b.workspace_id, je.value
  FROM blocks b, json_each(b.properties_json, '$.types') AS je
  WHERE b.deleted = 0 AND typeof(je.value) = 'text'
`,Q=`blocks_fts_backfill_v1`,xe=`
  SELECT 1 FROM client_schema_state WHERE key = '${Q}'
`,Se=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${Q}', strftime('%s', 'now') * 1000)
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
`,Te=1e3,Ee=4,De=`
  SELECT MAX(CAST(stat AS INTEGER)) AS rows FROM sqlite_stat1 WHERE tbl = 'blocks'
`,Oe=`
  SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1' LIMIT 1
`,ke=`SELECT COUNT(*) AS count FROM blocks`,Ae=`reproject_ref:`,je=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Ae}%'
`,Me=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Ne=`
  DELETE FROM client_schema_state WHERE key = ?
`,Pe=`workspace_backfill:`,Fe=`
  SELECT key FROM client_schema_state WHERE key LIKE '${Pe}%'
`,Ie=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Le=`reconcile_rescan_v1:`,Re=`
  SELECT key FROM client_schema_state WHERE key = ?
`,ze=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES (?, strftime('%s', 'now') * 1000)
`,Be=/^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i,Ve=e=>e.flatMap(e=>{let t=e.match(Be)?.[1];return t?[`DROP TRIGGER IF EXISTS ${t}`,e]:[e]}),He=async(e,t,n,r)=>{await e.execute(`DROP TRIGGER IF EXISTS ${t}`);try{await r()}finally{await e.execute(n)}},Ue=Ve([r,i,a,o,s,c,l,u,d,f,p,te,re,m,h,g,ee,_,ie,v,y,b,C,ne,P,F,I,z,B,V,H,U,W,G,K,q,J,Y,le,ue,fe,pe,me,x,S,T,E]),We=[`blocks_row_event_insert`,`blocks_row_event_update`,`blocks_row_event_delete`,`blocks_upload_insert`,`blocks_upload_update`,`blocks_parent_workspace_check_insert`,`blocks_parent_workspace_check_update`,`blocks_parent_not_deleted_check_insert`,`blocks_parent_not_deleted_check_update`,`blocks_alias_insert`,`blocks_alias_update`,`blocks_alias_delete`,`block_aliases_workspace_alias_unique`,`blocks_type_insert`,`blocks_type_update`,`blocks_type_delete`,`blocks_fts_insert`,`blocks_fts_update`,`blocks_fts_delete`,`blocks_synced_changes_insert`,`blocks_synced_changes_delete`,`pending_restage_clear_on_synced_insert`,`pending_restage_clear_on_synced_delete`],Ge=async e=>{await e.getOptional(he)===null&&(await e.execute(_e),await e.execute(ge))},Ke=async e=>{await e.getOptional(ve)===null&&(await e.execute(be),await e.execute(ye))},qe=async e=>{await e.getOptional(xe)===null&&(await e.execute(Ce),await e.execute(we),await e.execute(Se))},Je=async e=>{let t=!1;for(let n of[`blocks`,`blocks_synced`])(await e.getAll(`PRAGMA table_info(${n})`)).some(e=>e.name===`user_updated_at`)||(await e.execute(`ALTER TABLE ${n} ADD COLUMN user_updated_at INTEGER`),n===`blocks`&&(t=!0));t&&await He(e,`blocks_row_event_update`,F,async()=>{await e.execute(`UPDATE blocks SET user_updated_at = updated_at`)})},Ye=async e=>{for(let t of[`tx_context`,`row_events`]){let n=await e.getAll(`PRAGMA table_info(${t})`);n.length!==0&&(n.some(e=>e.name===`group_id`)||await e.execute(`ALTER TABLE ${t} ADD COLUMN group_id TEXT`))}},Xe=async e=>await e.getOptional(Oe)===null?null:(await e.getOptional(De))?.rows??null,$=async e=>(await e.getOptional(ke))?.count??0,Ze=(e,t,n=Te,r=4)=>t<n?!1:e===null||t>=e*r||e>=t*r,Qe=async(e,t={})=>{let n=t.minBlocks??1e3,r=t.growthFactor??4,i=await Xe(e),a=await $(e);return Ze(i,a,n,r)?(await e.execute(`ANALYZE`),{analyzed:!0,count:a,previousEstimate:i}):{analyzed:!1,count:a,previousEstimate:i}},$e=async e=>{let t=await $(e);return await e.execute(`ANALYZE`),{count:t}};export{X as ALIAS_BACKFILL_MARKER_KEY,Ee as ANALYZE_GROWTH_FACTOR,Te as ANALYZE_MIN_BLOCKS,Ce as BACKFILL_BLOCKS_FTS_ROWIDS_SQL,we as BACKFILL_BLOCKS_FTS_SQL,_e as BACKFILL_BLOCK_ALIASES_SQL,be as BACKFILL_BLOCK_TYPES_SQL,Q as BLOCKS_FTS_BACKFILL_MARKER_KEY,Z as BLOCK_TYPES_BACKFILL_MARKER_KEY,Ne as CLEAR_REPROJECT_REF_MARKER_SQL,Ue as CLIENT_SCHEMA_STATEMENTS,We as CLIENT_SCHEMA_TRIGGER_NAMES,q as CREATE_BLOCKS_ALIAS_DELETE_TRIGGER_SQL,G as CREATE_BLOCKS_ALIAS_INSERT_TRIGGER_SQL,K as CREATE_BLOCKS_ALIAS_UPDATE_TRIGGER_SQL,I as CREATE_BLOCKS_DELETE_ROW_EVENT_TRIGGER_SQL,me as CREATE_BLOCKS_FTS_DELETE_TRIGGER_SQL,fe as CREATE_BLOCKS_FTS_INSERT_TRIGGER_SQL,h as CREATE_BLOCKS_FTS_ROWIDS_TABLE_SQL,g as CREATE_BLOCKS_FTS_TABLE_SQL,pe as CREATE_BLOCKS_FTS_UPDATE_TRIGGER_SQL,P as CREATE_BLOCKS_INSERT_ROW_EVENT_TRIGGER_SQL,U as CREATE_BLOCKS_PARENT_NOT_DELETED_INSERT_TRIGGER_SQL,W as CREATE_BLOCKS_PARENT_NOT_DELETED_UPDATE_TRIGGER_SQL,S as CREATE_BLOCKS_SYNCED_CHANGES_DELETE_TRIGGER_SQL,b as CREATE_BLOCKS_SYNCED_CHANGES_ID_OP_INDEX_SQL,x as CREATE_BLOCKS_SYNCED_CHANGES_INSERT_TRIGGER_SQL,y as CREATE_BLOCKS_SYNCED_CHANGES_TABLE_SQL,ue as CREATE_BLOCKS_TYPE_DELETE_TRIGGER_SQL,Y as CREATE_BLOCKS_TYPE_INSERT_TRIGGER_SQL,le as CREATE_BLOCKS_TYPE_UPDATE_TRIGGER_SQL,F as CREATE_BLOCKS_UPDATE_ROW_EVENT_TRIGGER_SQL,z as CREATE_BLOCKS_UPLOAD_INSERT_TRIGGER_SQL,B as CREATE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL,V as CREATE_BLOCKS_WORKSPACE_INVARIANT_INSERT_TRIGGER_SQL,H as CREATE_BLOCKS_WORKSPACE_INVARIANT_UPDATE_TRIGGER_SQL,f as CREATE_BLOCK_ALIASES_TABLE_SQL,J as CREATE_BLOCK_ALIASES_WORKSPACE_UNIQUE_TRIGGER_SQL,p as CREATE_BLOCK_ALIASES_WS_ALIAS_INDEX_SQL,te as CREATE_BLOCK_ALIASES_WS_ALIAS_LOWER_INDEX_SQL,re as CREATE_BLOCK_TYPES_TABLE_SQL,m as CREATE_BLOCK_TYPES_TYPE_WORKSPACE_INDEX_SQL,ee as CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,u as CREATE_COMMAND_EVENTS_CREATED_INDEX_SQL,l as CREATE_COMMAND_EVENTS_TABLE_SQL,d as CREATE_COMMAND_EVENTS_WORKSPACE_INDEX_SQL,E as CREATE_PENDING_RESTAGE_CLEAR_ON_SYNCED_DELETE_TRIGGER_SQL,T as CREATE_PENDING_RESTAGE_CLEAR_ON_SYNCED_INSERT_TRIGGER_SQL,C as CREATE_PENDING_RESTAGE_TABLE_SQL,ie as CREATE_PS_CRUD_REJECTED_REJECTED_AT_INDEX_SQL,_ as CREATE_PS_CRUD_REJECTED_TABLE_SQL,v as CREATE_PS_CRUD_REJECTED_TX_ID_INDEX_SQL,s as CREATE_ROW_EVENTS_BLOCK_INDEX_SQL,c as CREATE_ROW_EVENTS_CREATED_INDEX_SQL,a as CREATE_ROW_EVENTS_TABLE_SQL,o as CREATE_ROW_EVENTS_TX_INDEX_SQL,r as CREATE_TX_CONTEXT_TABLE_SQL,ne as DROP_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,O as FLUSH_PENDING_RESTAGE_DELETE_SQL,D as FLUSH_PENDING_RESTAGE_ENQUEUE_SQL,Le as RECONCILE_RESCAN_MARKER_PREFIX,Se as RECORD_BLOCKS_FTS_BACKFILL_DONE_SQL,ge as RECORD_BLOCK_ALIASES_BACKFILL_DONE_SQL,ye as RECORD_BLOCK_TYPES_BACKFILL_DONE_SQL,ze as RECORD_RECONCILE_RESCAN_MARKER_SQL,Me as RECORD_REPROJECT_REF_MARKER_SQL,Ie as RECORD_WORKSPACE_BACKFILL_MARKER_SQL,Ae as REPROJECT_REF_MARKER_PREFIX,i as SEED_TX_CONTEXT_ROW_SQL,ke as SELECT_BLOCKS_COUNT_SQL,xe as SELECT_BLOCKS_FTS_BACKFILL_DONE_SQL,De as SELECT_BLOCKS_STAT_ESTIMATE_SQL,he as SELECT_BLOCK_ALIASES_BACKFILL_DONE_SQL,ve as SELECT_BLOCK_TYPES_BACKFILL_DONE_SQL,Re as SELECT_RECONCILE_RESCAN_MARKER_SQL,je as SELECT_REPROJECT_REF_MARKERS_SQL,Oe as SELECT_SQLITE_STAT1_EXISTS_SQL,Fe as SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,Pe as WORKSPACE_BACKFILL_MARKER_PREFIX,Ze as analyzeIsWarranted,Ge as backfillBlockAliasesIfEmpty,Ke as backfillBlockTypesIfEmpty,qe as backfillBlocksFtsIfEmpty,Je as ensureBlockUserUpdatedAtColumn,Ye as ensureUndoGroupIdColumns,ae as flushPendingRestage,$ as getBlocksCount,Xe as getBlocksStatEstimate,Qe as runAnalyzeIfStale,$e as runAnalyzeNow};
//# sourceMappingURL=clientSchema.js.map