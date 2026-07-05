var e=(e,t)=>`
  INSERT OR REPLACE INTO ${e} (
${t.map(e=>`        ${e.name}`).join(`,
`)}
      ) VALUES (${t.map(()=>`?`).join(`, `)})
`,t=e=>e.map(e=>e.name===`id`?`Id`:{Column:e.name}),n=(e,t)=>`
  CREATE TABLE IF NOT EXISTS ${e} (
${t.map(e=>`    ${e.definition}`).join(`,
`)}
  )
`,r=[{name:`id`,definition:`id TEXT PRIMARY KEY NOT NULL`},{name:`name`,definition:`name TEXT NOT NULL DEFAULT ''`},{name:`owner_user_id`,definition:`owner_user_id TEXT NOT NULL`},{name:`create_time`,definition:`create_time INTEGER NOT NULL`},{name:`update_time`,definition:`update_time INTEGER NOT NULL`},{name:`encryption_mode`,definition:`encryption_mode TEXT NOT NULL DEFAULT 'none'`},{name:`wk_canary`,definition:`wk_canary TEXT`}],i=n(`workspaces`,r),a=async e=>{let t=await e.getAll(`PRAGMA table_info(workspaces)`),n=new Set(t.map(e=>e.name));n.has(`encryption_mode`)||await e.execute(`ALTER TABLE workspaces ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'none'`),n.has(`wk_canary`)||await e.execute(`ALTER TABLE workspaces ADD COLUMN wk_canary TEXT`)},o={put:{sql:e(`workspaces`,r),params:t(r)},delete:{sql:`DELETE FROM workspaces WHERE id = ?`,params:[`Id`]}},s=e=>({id:e.id,name:e.name,ownerUserId:e.owner_user_id,createTime:e.create_time,updateTime:e.update_time,encryptionMode:e.encryption_mode,wkCanary:e.wk_canary}),c=[{name:`id`,definition:`id TEXT PRIMARY KEY NOT NULL`},{name:`workspace_id`,definition:`workspace_id TEXT NOT NULL`},{name:`user_id`,definition:`user_id TEXT NOT NULL`},{name:`role`,definition:`role TEXT NOT NULL`},{name:`create_time`,definition:`create_time INTEGER NOT NULL`}],l=n(`workspace_members`,c),u=`
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON workspace_members (user_id)
`,d={put:{sql:e(`workspace_members`,c),params:t(c)},delete:{sql:`DELETE FROM workspace_members WHERE id = ?`,params:[`Id`]}},f=e=>({id:e.id,workspaceId:e.workspace_id,userId:e.user_id,role:e.role,createTime:e.create_time});export{i as CREATE_WORKSPACES_TABLE_SQL,u as CREATE_WORKSPACE_MEMBERS_INDEX_SQL,l as CREATE_WORKSPACE_MEMBERS_TABLE_SQL,o as WORKSPACES_RAW_TABLE,r as WORKSPACE_COLUMNS,d as WORKSPACE_MEMBERS_RAW_TABLE,c as WORKSPACE_MEMBER_COLUMNS,a as ensureWorkspaceE2eeColumns,f as parseWorkspaceMemberRow,s as parseWorkspaceRow};
//# sourceMappingURL=workspaceSchema.js.map