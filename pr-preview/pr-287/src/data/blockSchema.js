var e=[{name:`id`,definition:`id TEXT PRIMARY KEY NOT NULL`},{name:`workspace_id`,definition:`workspace_id TEXT NOT NULL`},{name:`parent_id`,definition:`parent_id TEXT`},{name:`order_key`,definition:`order_key TEXT NOT NULL`},{name:`content`,definition:`content TEXT NOT NULL DEFAULT ''`},{name:`properties_json`,definition:`properties_json TEXT NOT NULL DEFAULT '{}'`},{name:`references_json`,definition:`references_json TEXT NOT NULL DEFAULT '[]'`},{name:`created_at`,definition:`created_at INTEGER NOT NULL`},{name:`updated_at`,definition:`updated_at INTEGER NOT NULL`},{name:`user_updated_at`,definition:`user_updated_at INTEGER`},{name:`created_by`,definition:`created_by TEXT NOT NULL`},{name:`updated_by`,definition:`updated_by TEXT NOT NULL`},{name:`deleted`,definition:`deleted INTEGER NOT NULL DEFAULT 0`}],t=e.map(e=>e.name),n=(e,t)=>{let n=` `.repeat(t);return e.map(e=>`${n}${e}`).join(`,
`)},r=t.join(`,
  `),i=e=>t.map(t=>`${e}.${t} AS ${t}`).join(`,
  `),a=`
  CREATE TABLE IF NOT EXISTS blocks (
${n(e.map(e=>e.definition),6)}
  )
`,o=`
  CREATE TABLE IF NOT EXISTS blocks_synced (
${n(e.map(e=>e.definition),6)}
  )
`,s=`
  CREATE INDEX IF NOT EXISTS idx_blocks_parent_order
  ON blocks (parent_id, order_key, id)
  WHERE deleted = 0
`,c=`
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_active
  ON blocks (workspace_id)
  WHERE deleted = 0
`,l={put:{sql:`
      INSERT OR REPLACE INTO blocks_synced (
${n(t,8)}
      ) VALUES (${t.map(()=>`?`).join(`, `)})
    `,params:t.map(e=>e===`id`?`Id`:{Column:e})},delete:{sql:`DELETE FROM blocks_synced WHERE id = ?`,params:[`Id`]}},u=[{key:`id`,sqlExpression:e=>`${e}.id`},{key:`workspaceId`,sqlExpression:e=>`${e}.workspace_id`},{key:`parentId`,sqlExpression:e=>`${e}.parent_id`},{key:`orderKey`,sqlExpression:e=>`${e}.order_key`},{key:`content`,sqlExpression:e=>`${e}.content`},{key:`properties`,sqlExpression:e=>`json(${e}.properties_json)`},{key:`references`,sqlExpression:e=>`json(${e}.references_json)`},{key:`createdAt`,sqlExpression:e=>`${e}.created_at`},{key:`updatedAt`,sqlExpression:e=>`${e}.updated_at`},{key:`userUpdatedAt`,sqlExpression:e=>`coalesce(${e}.user_updated_at, ${e}.updated_at)`},{key:`createdBy`,sqlExpression:e=>`${e}.created_by`},{key:`updatedBy`,sqlExpression:e=>`${e}.updated_by`},{key:`deleted`,sqlExpression:e=>`json(CASE WHEN ${e}.deleted THEN 'true' ELSE 'false' END)`}],d=e=>`
  json_object(
${n(u.map(t=>`'${t.key}', ${t.sqlExpression(e)}`),4)}
  )
`,f=(e,t)=>{if(!e)return t;try{return JSON.parse(e)}catch(e){return console.warn(`Failed to parse stored block JSON`,e),t}},p=e=>e?f(e,null)??void 0:void 0,m=e=>({id:e.id,workspaceId:e.workspace_id,parentId:e.parent_id,orderKey:e.order_key,content:e.content,properties:f(e.properties_json,{}),references:f(e.references_json,[]),createdAt:e.created_at,updatedAt:e.updated_at,userUpdatedAt:e.user_updated_at??e.updated_at,createdBy:e.created_by,updatedBy:e.updated_by,deleted:!!e.deleted}),h=e=>[e.id,e.workspaceId,e.parentId,e.orderKey,e.content,JSON.stringify(e.properties??{}),JSON.stringify(e.references??[]),e.createdAt,e.updatedAt,e.userUpdatedAt,e.createdBy,e.updatedBy,+!!e.deleted];export{l as BLOCKS_SYNCED_RAW_TABLE,e as BLOCK_STORAGE_COLUMNS,s as CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,o as CREATE_BLOCKS_SYNCED_TABLE_SQL,a as CREATE_BLOCKS_TABLE_SQL,c as CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,r as SELECT_BLOCK_COLUMNS_SQL,h as blockToRowParams,d as buildBlockSnapshotJsonSql,i as buildQualifiedBlockColumnsSql,m as parseBlockRow,p as parseBlockSnapshotJson};
//# sourceMappingURL=blockSchema.js.map