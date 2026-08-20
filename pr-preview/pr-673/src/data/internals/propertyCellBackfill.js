import{getPropertyFieldTargetId as e}from"../propertyChildren.js";import{materializePropertyChildrenForExistingRow as t}from"./propertyChildrenProcessor.js";import{CallbackSet as n}from"../../utils/callbackSet.js";var r=`properties:cell-to-children`,i=190,a=2,o=500,s=`
     b.properties_json <> '{}'
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,c=`
  SELECT b.id AS id,
         (SELECT COUNT(*) FROM json_each(b.properties_json)) AS keys
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND ${s}
   ORDER BY b.id
   LIMIT ?`,l=`
  SELECT f.parent_id AS id, COUNT(*) AS keys
    FROM blocks f
    JOIN blocks b ON b.id = f.parent_id
   WHERE f.workspace_id = ?
     AND f.deleted = 0
     AND f.is_field_form = 1
     AND f.parent_id > ?
     AND b.workspace_id = f.workspace_id
     AND b.deleted = 0
     AND NOT (${s})
   GROUP BY f.parent_id
   ORDER BY f.parent_id
   LIMIT ?`,u=`
  SELECT COUNT(*) AS n, COALESCE(MAX(b.updated_at), 0) AS t
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`,d=async(e,t)=>(await e(`SELECT COUNT(*) AS n
       FROM blocks b INDEXED BY idx_blocks_workspace_nonempty_properties
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND ${s}`,[t]))[0]?.n??0,f=new n(`property-cell-backfill`),p=e=>f.add(e),m=50,h=4,g=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await _(e,n)){let e=t.resolveFieldSchema(i);e&&r.add(e.name)}return[...r]},_=async(t,n)=>{let r=new Set;for(let i of await t.childrenOf(n.id,void 0)){let t=i.isFieldForm?e(i):void 0;t!==void 0&&r.add(t)}return r},v=async(e,t,n)=>{let r=await _(e,n),i=await e.reapedPropertyFieldTargets(n.id);return Object.keys(n.properties).filter(e=>{let n=t.resolveNameSchema(e)?.fieldId;return n===void 0?!1:!(r.has(n)||i.has(n))})},y=async(e,n,r,i,a,o)=>{let s={resolveNameSchema:n.resolveNameSchema};try{return await t(e,r,s,i),o(i.length),!0}catch{for(let n of i)try{await t(e,r,s,[n]),o(1)}catch(e){a(r.id,e)}return!1}},b=async(e,t,n,r,{deletesOnly:i})=>{let a=!1,s=(e,t)=>{n.failureCount+=1,n.failures.length<m&&n.failures.push({blockId:e,reason:t instanceof Error?t.message:String(t)})},c=``,l=[];for(;;){if(l.length===0){if(l=await e.getAll(t,[e.workspaceId,c,o]),l.length===0)return{sawChildBacked:a};c=l[l.length-1].id}let u=[],d=0;for(;l.length>0&&(u.length===0||d+l[0].keys*2<=190);){let e=l.shift();u.push(e),d+=e.keys*2}if(await e.tx(async t=>{let r=await t.isPropertyChildBackedWorkspace(e.workspaceId);if(r&&(a=!0),r&&i)return!0;for(let{id:i}of u){n.blocksScanned+=1;let a=await t.get(i);a===null||a.deleted||await y(t,e,a,r?await v(t,e,a):await g(t,e,a),s,e=>{n.valuesMaterialized+=e,n.valuesMaterializedTotal+=e})&&(n.blocksMaterialized+=1)}return!1},{description:`Migrate properties to child blocks`}))return{sawChildBacked:a};await r()}},x=async(e,t)=>{let n={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1},i=async()=>{let t=await e.getAll(u,[e.workspaceId]);return{n:t[0]?.n??0,t:t[0]?.t??0}};for(;;){let a=await i();n.sweeps+=1,n.blocksScanned=0,n.blocksMaterialized=0,n.valuesMaterialized=0,n.failures=[],n.failureCount=0;let o=async()=>{await t?.(n)},{sawChildBacked:s}=await b(e,c,n,o,{deletesOnly:!1}),u=n.blocksScanned;if(await b(e,l,n,o,{deletesOnly:!0}),n.orphanedOwnersSwept+=n.blocksScanned-u,s){if(n.valuesMaterialized===0){await t?.(n);break}}else{let e=await i();if(e.n===a.n){n.editedUnderPass=e.t!==a.t,await t?.(n);break}}if(n.sweeps>=h)throw Error(`[${r}] gave up after ${h} sweeps: the workspace's property children kept changing, which means it is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return n},S=null,C=e=>{if(S?.workspaceId!==e)return null;let{progress:t}=S;return S=null,t},w={id:r,trigger:`operator`,run:async e=>{S=null;let t={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1};try{Object.assign(t,await x(e,e=>{Object.assign(t,e),console.info(`[${r}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),f.notify(e)}))}finally{S={workspaceId:e.workspaceId,progress:t}}t.failureCount>0&&console.warn(`[${r}] ${t.failureCount} property value(s) could not be migrated and kept their cell value:`,t.failures)}};export{c as CANDIDATE_SQL,r as PROPERTY_CELL_BACKFILL_ID,a as ROWS_PER_KEY,i as TARGET_INSERT_ROWS,d as countPropertyCellBackfillCandidates,p as onPropertyCellBackfillProgress,w as propertyCellBackfill,x as runPropertyCellBackfill,C as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map