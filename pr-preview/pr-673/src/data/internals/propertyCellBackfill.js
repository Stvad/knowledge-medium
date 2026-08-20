import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";import{CallbackSet as t}from"../../utils/callbackSet.js";var n=`properties:cell-to-children`,r=190,i=2,a=500,o=new Set,s=`
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
        AND ${s}`,[t]))[0]?.n??0,f=new t(`property-cell-backfill`),p=e=>f.add(e),m=50,h=4,g=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await e.childrenOf(n.id,void 0)){let e=i.referenceTargetId;if(!i.isFieldForm||!e)continue;let n=t.resolveFieldSchema(e);n&&r.add(n.name)}return[...r]},_=async(e,t)=>{let n=await e.getAll(`SELECT parent_id AS ownerId, reference_target_id AS fieldId
       FROM blocks
      WHERE workspace_id = ? AND is_field_form = 1 AND deleted = 1
        AND reference_target_id IS NOT NULL
        AND parent_id IN (${t.map(()=>`?`).join(`,`)})`,[e.workspaceId,...t]),r=new Map;for(let{ownerId:e,fieldId:t}of n){let n=r.get(e)??new Set;n.add(t),r.set(e,n)}return r},v=async(e,t,n,r)=>{let i=new Set;for(let t of await e.childrenOf(n.id,void 0))t.isFieldForm&&t.referenceTargetId&&i.add(t.referenceTargetId);return Object.keys(n.properties).filter(e=>{let n=t.resolveNameSchema(e)?.fieldId;return n===void 0||!(i.has(n)||r.has(n))})},y=async(t,n,r,i,a,o)=>{let s={resolveNameSchema:n.resolveNameSchema};try{return await e(t,r,s,i),o(i.length),!0}catch{for(let n of i)try{await e(t,r,s,[n]),o(1)}catch(e){a(r.id,e)}return!1}},b=async(e,t,n,r,{deletesOnly:i})=>{let s=!1,c=(e,t)=>{n.failureCount+=1,n.failures.length<m&&n.failures.push({blockId:e,reason:t instanceof Error?t.message:String(t)})},l=``,u=[];for(;;){if(u.length===0){if(u=await e.getAll(t,[e.workspaceId,l,a]),u.length===0)return{sawChildBacked:s};l=u[u.length-1].id}let d=[],f=0;for(;u.length>0&&(d.length===0||f+u[0].keys*2<=190);){let e=u.shift();d.push(e),f+=e.keys*2}let p=await _(e,d.map(({id:e})=>e)),m=!1;if(await e.tx(async t=>{let r=await t.isPropertyChildBackedWorkspace(e.workspaceId);if(r&&(s=!0),r&&i){m=!0;return}for(let{id:i}of d){n.blocksScanned+=1;let a=await t.get(i);a===null||a.deleted||await y(t,e,a,r?await v(t,e,a,p.get(i)??o):await g(t,e,a),c,e=>{n.valuesMaterialized+=e,n.valuesMaterializedTotal+=e})&&(n.blocksMaterialized+=1)}},{description:`Migrate properties to child blocks`}),m)return{sawChildBacked:s};await r()}},x=async(e,t)=>{let r={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1},i=async()=>{let t=await e.getAll(u,[e.workspaceId]);return{n:t[0]?.n??0,t:t[0]?.t??0}};for(;;){let a=await i();r.sweeps+=1,r.blocksScanned=0,r.blocksMaterialized=0,r.valuesMaterialized=0,r.failures=[],r.failureCount=0;let o=async()=>{await t?.(r)},{sawChildBacked:s}=await b(e,c,r,o,{deletesOnly:!1}),u=r.blocksScanned;if(await b(e,l,r,o,{deletesOnly:!0}),r.orphanedOwnersSwept+=r.blocksScanned-u,s){if(r.valuesMaterialized===0){await t?.(r);break}}else{let e=await i();if(e.n===a.n){r.editedUnderPass=e.t!==a.t,await t?.(r);break}}if(r.sweeps>=h)throw Error(`[${n}] gave up after ${h} sweeps: the workspace's property children kept changing, which means it is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return r},S=null,C=e=>{if(S?.workspaceId!==e)return null;let{progress:t}=S;return S=null,t},w={id:n,trigger:`operator`,run:async e=>{S=null;let t={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,valuesMaterializedTotal:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1};try{Object.assign(t,await x(e,e=>{Object.assign(t,e),console.info(`[${n}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),f.notify(e)}))}finally{S={workspaceId:e.workspaceId,progress:t}}t.failureCount>0&&console.warn(`[${n}] ${t.failureCount} property value(s) could not be migrated and kept their cell value:`,t.failures)}};export{c as CANDIDATE_SQL,n as PROPERTY_CELL_BACKFILL_ID,i as ROWS_PER_KEY,r as TARGET_INSERT_ROWS,d as countPropertyCellBackfillCandidates,p as onPropertyCellBackfillProgress,w as propertyCellBackfill,x as runPropertyCellBackfill,C as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map