var e=[{name:`id`,definition:`id TEXT PRIMARY KEY NOT NULL`},{name:`workspace_id`,definition:`workspace_id TEXT NOT NULL`},{name:`parent_id`,definition:`parent_id TEXT`},{name:`order_key`,definition:`order_key TEXT NOT NULL`},{name:`content`,definition:`content TEXT NOT NULL DEFAULT ''`},{name:`properties_json`,definition:`properties_json TEXT NOT NULL DEFAULT '{}'`},{name:`references_json`,definition:`references_json TEXT NOT NULL DEFAULT '[]'`},{name:`created_at`,definition:`created_at INTEGER NOT NULL`},{name:`updated_at`,definition:`updated_at INTEGER NOT NULL`},{name:`user_updated_at`,definition:`user_updated_at INTEGER`},{name:`created_by`,definition:`created_by TEXT NOT NULL`},{name:`updated_by`,definition:`updated_by TEXT NOT NULL`},{name:`deleted`,definition:`deleted INTEGER NOT NULL DEFAULT 0`}],t=[{name:`reference_target_id`,definition:`reference_target_id TEXT`},{name:`is_field_form`,definition:`is_field_form INTEGER`}],n=e.map(e=>e.name),r=[...n,...t.map(e=>e.name)],i=(e,t)=>{let n=` `.repeat(t);return e.map(e=>`${n}${e}`).join(`,
`)},a=r.join(`,
  `),o=e=>r.map(t=>`${e}.${t} AS ${t}`).join(`,
  `),s=`
  CREATE TABLE IF NOT EXISTS blocks (
${i([...e,...t].map(e=>e.definition),6)}
  )
`,c=async e=>{let n=await e.getAll(`PRAGMA table_info(blocks)`);if(n.length!==0)for(let r of t)n.some(e=>e.name===r.name)||await e.execute(`ALTER TABLE blocks ADD COLUMN ${r.definition}`)},l=`
  CREATE TABLE IF NOT EXISTS blocks_synced (
${i(e.map(e=>e.definition),6)}
  )
`,u=`
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_order
  ON blocks (parent_id, order_key, id)
  WHERE deleted = 0
`,d=`
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
`,f=`
  CREATE INDEX IF NOT EXISTS idx_blocks_reference_target_parent
  ON blocks (workspace_id, reference_target_id, parent_id)
  WHERE deleted = 0 AND reference_target_id IS NOT NULL
`,p=`
  CREATE INDEX IF NOT EXISTS idx_blocks_field_form
  ON blocks (workspace_id, parent_id, reference_target_id)
  WHERE deleted = 0 AND is_field_form = 1
`,m={put:{sql:`
      INSERT OR REPLACE INTO blocks_synced (
${i(n,8)}
      ) VALUES (${n.map(()=>`?`).join(`, `)})
    `,params:n.map(e=>e===`id`?`Id`:{Column:e})},delete:{sql:`DELETE FROM blocks_synced WHERE id = ?`,params:[`Id`]}},h=[{key:`id`,sqlExpression:e=>`${e}.id`},{key:`workspaceId`,sqlExpression:e=>`${e}.workspace_id`},{key:`parentId`,sqlExpression:e=>`${e}.parent_id`},{key:`referenceTargetId`,sqlExpression:e=>`${e}.reference_target_id`},{key:`isFieldForm`,sqlExpression:e=>`json(CASE WHEN ${e}.is_field_form = 1 THEN 'true' ELSE 'false' END)`},{key:`orderKey`,sqlExpression:e=>`${e}.order_key`},{key:`content`,sqlExpression:e=>`${e}.content`},{key:`properties`,sqlExpression:e=>`json(${e}.properties_json)`},{key:`references`,sqlExpression:e=>`json(${e}.references_json)`},{key:`createdAt`,sqlExpression:e=>`${e}.created_at`},{key:`updatedAt`,sqlExpression:e=>`${e}.updated_at`},{key:`userUpdatedAt`,sqlExpression:e=>`coalesce(${e}.user_updated_at, ${e}.updated_at)`},{key:`createdBy`,sqlExpression:e=>`${e}.created_by`},{key:`updatedBy`,sqlExpression:e=>`${e}.updated_by`},{key:`deleted`,sqlExpression:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],g=e=>`
  json_object(
${i(h.map(t=>`'${t.key}', ${t.sqlExpression(e)}`),4)}
  )
`,_=(e,t)=>{if(!e)return t;try{return JSON.parse(e)}catch(e){return console.warn(`Failed to parse stored block JSON`,e),t}},v=e=>e?_(e,null)??void 0:void 0,y=e=>({id:e.id,workspaceId:e.workspace_id,parentId:e.parent_id,referenceTargetId:e.reference_target_id??null,isFieldForm:e.is_field_form===1,orderKey:e.order_key,content:e.content,properties:_(e.properties_json,{}),references:_(e.references_json,[]),createdAt:e.created_at,updatedAt:e.updated_at,userUpdatedAt:e.user_updated_at??e.updated_at,createdBy:e.created_by,updatedBy:e.updated_by,deleted:!!e.deleted}),b=e=>[e.id,e.workspaceId,e.parentId,e.orderKey,e.content,JSON.stringify(e.properties??{}),JSON.stringify(e.references??[]),e.createdAt,e.updatedAt,e.userUpdatedAt,e.createdBy,e.updatedBy,+!!e.deleted,e.referenceTargetId??null,e.isFieldForm?1:null],x=t=>b(t).slice(0,e.length);export{m as BLOCKS_SYNCED_RAW_TABLE,r as BLOCKS_TABLE_COLUMN_NAMES,t as BLOCK_LOCAL_COLUMNS,e as BLOCK_STORAGE_COLUMNS,p as CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,u as CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,f as CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,l as CREATE_BLOCKS_SYNCED_TABLE_SQL,s as CREATE_BLOCKS_TABLE_SQL,d as CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,a as SELECT_BLOCK_COLUMNS_SQL,b as blockToRowParams,x as blockToSyncedRowParams,g as buildBlockSnapshotJsonSql,o as buildQualifiedBlockColumnsSql,c as ensureBlockLocalColumns,y as parseBlockRow,v as parseBlockSnapshotJson};
//# sourceMappingURL=blockSchema.js.map