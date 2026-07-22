import{useQuery as e}from"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/hooks/watched/useQuery.js";import"../../node_modules/.pnpm/@powersync_react@1.10.0_@powersync_common@1.55.0_react@19.2.6/node_modules/@powersync/react/lib/index.js";import{useHash as t}from"../../node_modules/.pnpm/react-use@17.6.0_react-dom@19.2.6_react@19.2.6__react@19.2.6/node_modules/react-use/esm/useHash.js";import{useRepo as n}from"../context/repo.js";import{parseAppHash as r}from"../utils/routing.js";import{c as i}from"react/compiler-runtime";var a=()=>{let e=i(3),a=n(),[o]=t(),s;return e[0]!==o||e[1]!==a.activeWorkspaceId?(s=a.activeWorkspaceId??r(o).workspaceId??null,e[0]=o,e[1]=a.activeWorkspaceId,e[2]=s):s=e[2],s},o=`
  SELECT id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary
  FROM workspaces
  ORDER BY create_time ASC, id ASC
`,s=`
  SELECT id, workspace_id, user_id, role, create_time
  FROM workspace_members
  WHERE workspace_id = ?
  ORDER BY create_time ASC, id ASC
`,c=e=>({id:e.id,name:e.name,ownerUserId:e.owner_user_id,createTime:e.create_time,updateTime:e.update_time,encryptionMode:e.encryption_mode,wkCanary:e.wk_canary}),l=e=>({id:e.id,workspaceId:e.workspace_id,userId:e.user_id,role:e.role,createTime:e.create_time}),u=()=>{let t=i(5),{data:n,isLoading:r}=e(o),a;t[0]===n?a=t[1]:(a=n.map(c),t[0]=n,t[1]=a);let s;return t[2]!==r||t[3]!==a?(s={workspaces:a,isLoading:r},t[2]=r,t[3]=a,t[4]=s):s=t[4],s},d=t=>{let n=i(8),r=t??``,a;n[0]===r?a=n[1]:(a=[r],n[0]=r,n[1]=a);let{data:o,isLoading:c}=e(s,a),u;n[2]!==o||n[3]!==t?(u=t?o.map(l):[],n[2]=o,n[3]=t,n[4]=u):u=n[4];let d;return n[5]!==c||n[6]!==u?(d={members:u,isLoading:c},n[5]=c,n[6]=u,n[7]=d):d=n[7],d},f=`
  SELECT workspace_id, role
  FROM workspace_members
  WHERE user_id = ?
`,p=()=>{let t=i(7),r=n(),a;t[0]===r.user.id?a=t[1]:(a=[r.user.id],t[0]=r.user.id,t[1]=a);let{data:o,isLoading:s}=e(f,a),c;t[2]===o?c=t[3]:(c=new Map(o.map(m)),t[2]=o,t[3]=c);let l=c,u;return t[4]!==s||t[5]!==l?(u={rolesByWorkspaceId:l,isLoading:s},t[4]=s,t[5]=l,t[6]=u):u=t[6],u};function m(e){return[e.workspace_id,e.role]}export{a as useActiveWorkspaceId,p as useMyWorkspaceRoles,d as useWorkspaceMembers,u as useWorkspaces};
//# sourceMappingURL=useWorkspaces.js.map