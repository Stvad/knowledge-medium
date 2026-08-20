import{getPropertyFieldTargetId as e}from"../propertyChildren.js";import{materializePropertyChildrenForExistingRow as t}from"./propertyChildrenProcessor.js";import{CallbackSet as n}from"../../utils/callbackSet.js";var r=`properties:cell-to-children`,i=190,a=2,o=500,s=new Set,c=`
     b.properties_json <> '{}'
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,l=`
  SELECT b.id AS id,
         (SELECT COUNT(*) FROM json_each(b.properties_json)) AS keys
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND ${c}
   ORDER BY b.id
   LIMIT ?`,u=`
  SELECT f.parent_id AS id, COUNT(*) AS keys
    FROM blocks f
    JOIN blocks b ON b.id = f.parent_id
   WHERE f.workspace_id = ?
     AND f.deleted = 0
     AND f.is_field_form = 1
     AND f.parent_id > ?
     AND b.workspace_id = f.workspace_id
     AND b.deleted = 0
     AND NOT (${c})
   GROUP BY f.parent_id
   ORDER BY f.parent_id
   LIMIT ?`,d=`
  SELECT COUNT(*) AS n, COALESCE(MAX(b.updated_at), 0) AS t
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`,f=async(e,t)=>(await e(`SELECT COUNT(*) AS n
       FROM blocks b INDEXED BY idx_blocks_workspace_nonempty_properties
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND ${c}`,[t]))[0]?.n??0,p=new n(`property-cell-backfill`),m=e=>p.add(e),h=50,g=4,_=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await v(e,n)){let e=t.resolveFieldSchema(i);e&&r.add(e.name)}return[...r]},v=async(t,n)=>{let r=new Set;for(let i of await t.childrenOf(n.id,void 0)){let t=i.isFieldForm?e(i):void 0;t!==void 0&&r.add(t)}return r},y=async(e,t)=>{let n=await e.getAll(`SELECT parent_id AS ownerId, reference_target_id AS fieldId
       FROM blocks
      WHERE workspace_id = ? AND is_field_form = 1 AND deleted = 1
        AND reference_target_id IS NOT NULL
        AND parent_id IN (${t.map(()=>`?`).join(`,`)})`,[e.workspaceId,...t]),r=new Map;for(let{ownerId:e,fieldId:t}of n){let n=r.get(e)??new Set;n.add(t),r.set(e,n)}return r},b=async(e,t,n,r)=>{let i=await v(e,n);return Object.keys(n.properties).filter(e=>{let n=t.resolveNameSchema(e)?.fieldId;return n===void 0||!(i.has(n)||r.has(n))})},x=async(e,n,r,i,a,o)=>{let s={resolveNameSchema:n.resolveNameSchema};try{return await t(e,r,s,i),o(i.length),!0}catch{for(let n of i)try{await t(e,r,s,[n]),o(1)}catch(e){a(r.id,e)}return!1}},S=async(e,t,n,r,{deletesOnly:i})=>{let a=!1,c=(e,t)=>{n.failureCount+=1,n.failures.length<h&&n.failures.push({blockId:e,reason:t instanceof Error?t.message:String(t)})},l=``,u=[];for(;;){if(u.length===0){if(u=await e.getAll(t,[e.workspaceId,l,o]),u.length===0)return{sawChildBacked:a};l=u[u.length-1].id}let d=[],f=0;for(;u.length>0&&(d.length===0||f+u[0].keys*2<=190);){let e=u.shift();d.push(e),f+=e.keys*2}let p=await y(e,d.map(({id:e})=>e));if(await e.tx(async t=>{let r=await t.isPropertyChildBackedWorkspace(e.workspaceId);if(r&&(a=!0),r&&i)return!0;for(let{id:i}of d){n.blocksScanned+=1;let a=await t.get(i);a===null||a.deleted||await x(t,e,a,r?await b(t,e,a,p.get(i)??s):await _(t,e,a),c,e=>{n.valuesMaterialized+=e,n.valuesMaterializedTotal+=e})&&(n.blocksMaterialized+=1)}return!1},{description:`Migrate properties to child blocks`}))return{sawChildBacked:a};await r()}},C=async(e,t)=>{let n={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1},i=async()=>{let t=await e.getAll(d,[e.workspaceId]);return{n:t[0]?.n??0,t:t[0]?.t??0}};for(;;){let a=await i();n.sweeps+=1,n.blocksScanned=0,n.blocksMaterialized=0,n.valuesMaterialized=0,n.failures=[],n.failureCount=0;let o=async()=>{await t?.(n)},{sawChildBacked:s}=await S(e,l,n,o,{deletesOnly:!1}),c=n.blocksScanned;if(await S(e,u,n,o,{deletesOnly:!0}),n.orphanedOwnersSwept+=n.blocksScanned-c,s){if(n.valuesMaterialized===0){await t?.(n);break}}else{let e=await i();if(e.n===a.n){n.editedUnderPass=e.t!==a.t,await t?.(n);break}}if(n.sweeps>=g)throw Error(`[${r}] gave up after ${g} sweeps: the workspace's property children kept changing, which means it is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return n},w=null,T=e=>{if(w?.workspaceId!==e)return null;let{progress:t}=w;return w=null,t},E={id:r,trigger:`operator`,run:async e=>{w=null;let t={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1};try{Object.assign(t,await C(e,e=>{Object.assign(t,e),console.info(`[${r}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),p.notify(e)}))}finally{w={workspaceId:e.workspaceId,progress:t}}t.failureCount>0&&console.warn(`[${r}] ${t.failureCount} property value(s) could not be migrated and kept their cell value:`,t.failures)}};export{l as CANDIDATE_SQL,r as PROPERTY_CELL_BACKFILL_ID,a as ROWS_PER_KEY,i as TARGET_INSERT_ROWS,f as countPropertyCellBackfillCandidates,m as onPropertyCellBackfillProgress,E as propertyCellBackfill,C as runPropertyCellBackfill,T as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map