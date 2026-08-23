import{parsePropertiesMigration as e}from"../data/workspaceSchema.js";import{useQuery as t}from"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/hooks/watched/useQuery.js";import"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/index.js";import{useHash as n}from"../../node_modules/.pnpm/react-use@17.6.0_react-dom@19.2.6_react@19.2.6__react@19.2.6/node_modules/react-use/esm/useHash.js";import{useRepo as r}from"../context/repo.js";import{parseAppHash as i}from"../utils/routing.js";import{c as a}from"react/compiler-runtime";var o=()=>{let e=a(3),t=r(),[o]=n(),s;return e[0]!==o||e[1]!==t.activeWorkspaceId?(s=t.activeWorkspaceId??i(o).workspaceId??null,e[0]=o,e[1]=t.activeWorkspaceId,e[2]=s):s=e[2],s},s=`
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode,
         wk_canary, properties_migration
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`,c=`
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`,l=t=>({id:t.id,name:t.name,ownerUserId:t.owner_user_id,createTime:t.create_time,updateTime:t.update_time,encryptionMode:t.encryption_mode,wkCanary:t.wk_canary,propertiesMigration:e(t.properties_migration)}),u=e=>({id:e.id,workspaceId:e.workspace_id,userId:e.user_id,role:e.role,createTime:e.create_time}),d=()=>{let e=a(5),{data:n,isLoading:r}=t(s),i;e[0]===n?i=e[1]:(i=n.map(l),e[0]=n,e[1]=i);let o;return e[2]!==r||e[3]!==i?(o={workspaces:i,isLoading:r},e[2]=r,e[3]=i,e[4]=o):o=e[4],o},f=e=>{let n=a(8),r=e??``,i;n[0]===r?i=n[1]:(i=[r],n[0]=r,n[1]=i);let{data:o,isLoading:s}=t(c,i),l;n[2]!==o||n[3]!==e?(l=e?o.map(u):[],n[2]=o,n[3]=e,n[4]=l):l=n[4];let d;return n[5]!==s||n[6]!==l?(d={members:l,isLoading:s},n[5]=s,n[6]=l,n[7]=d):d=n[7],d},p=`
  SELECT workspace_id, role
  FROM workspace_members
  WHERE user_id = ?
`,m=()=>{let e=a(7),n=r(),i;e[0]===n.user.id?i=e[1]:(i=[n.user.id],e[0]=n.user.id,e[1]=i);let{data:o,isLoading:s}=t(p,i),c;e[2]===o?c=e[3]:(c=new Map(o.map(h)),e[2]=o,e[3]=c);let l=c,u;return e[4]!==s||e[5]!==l?(u={rolesByWorkspaceId:l,isLoading:s},e[4]=s,e[5]=l,e[6]=u):u=e[6],u};function h(e){return[e.workspace_id,e.role]}export{o as useActiveWorkspaceId,m as useMyWorkspaceRoles,f as useWorkspaceMembers,d as useWorkspaces};
//# sourceMappingURL=useWorkspaces.js.map