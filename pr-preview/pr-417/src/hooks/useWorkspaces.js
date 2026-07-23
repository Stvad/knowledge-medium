import{useQuery as e}from"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/hooks/watched/useQuery.js";import"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/index.js";import{parsePropertiesMigration as t}from"../data/workspaceSchema.js";import{useHash as n}from"../../node_modules/.pnpm/react-use@17.6.0_react-dom@19.2.6_react@19.2.6__react@19.2.6/node_modules/react-use/esm/useHash.js";import{useRepo as r}from"../context/repo.js";import{parseAppHash as i}from"../utils/routing.js";import{c as a}from"react/compiler-runtime";var o=()=>{let e=a(3),t=r(),[o]=n(),s;return e[0]!==o||e[1]!==t.activeWorkspaceId?(s=t.activeWorkspaceId??i(o).workspaceId??null,e[0]=o,e[1]=t.activeWorkspaceId,e[2]=s):s=e[2],s},s=`
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode,
         wk_canary, properties_migration
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`,c=`
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`,l=e=>({id:e.id,name:e.name,ownerUserId:e.owner_user_id,createTime:e.create_time,updateTime:e.update_time,encryptionMode:e.encryption_mode,wkCanary:e.wk_canary,propertiesMigration:t(e.properties_migration)}),u=e=>({id:e.id,workspaceId:e.workspace_id,userId:e.user_id,role:e.role,createTime:e.create_time}),d=()=>{let t=a(5),{data:n,isLoading:r}=e(s),i;t[0]===n?i=t[1]:(i=n.map(l),t[0]=n,t[1]=i);let o;return t[2]!==r||t[3]!==i?(o={workspaces:i,isLoading:r},t[2]=r,t[3]=i,t[4]=o):o=t[4],o},f=t=>{let n=a(8),r=t??``,i;n[0]===r?i=n[1]:(i=[r],n[0]=r,n[1]=i);let{data:o,isLoading:s}=e(c,i),l;n[2]!==o||n[3]!==t?(l=t?o.map(u):[],n[2]=o,n[3]=t,n[4]=l):l=n[4];let d;return n[5]!==s||n[6]!==l?(d={members:l,isLoading:s},n[5]=s,n[6]=l,n[7]=d):d=n[7],d},p=`
  SELECT workspace_id, role
  FROM workspace_members
  WHERE user_id = ?
`,m=()=>{let t=a(7),n=r(),i;t[0]===n.user.id?i=t[1]:(i=[n.user.id],t[0]=n.user.id,t[1]=i);let{data:o,isLoading:s}=e(p,i),c;t[2]===o?c=t[3]:(c=new Map(o.map(h)),t[2]=o,t[3]=c);let l=c,u;return t[4]!==s||t[5]!==l?(u={rolesByWorkspaceId:l,isLoading:s},t[4]=s,t[5]=l,t[6]=u):u=t[6],u};function h(e){return[e.workspace_id,e.role]}export{o as useActiveWorkspaceId,m as useMyWorkspaceRoles,f as useWorkspaceMembers,d as useWorkspaces};
//# sourceMappingURL=useWorkspaces.js.map