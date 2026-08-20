import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";import{CallbackSet as t}from"../../utils/callbackSet.js";var n=`properties:cell-to-children`,r=190,i=2,a=500,o=`
     b.properties_json <> '{}'
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,s=`
  SELECT b.id AS id,
         (SELECT COUNT(*) FROM json_each(b.properties_json)) AS keys
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND ${o}
   ORDER BY b.id
   LIMIT ?`,c=`
  SELECT f.parent_id AS id, COUNT(*) AS keys
    FROM blocks f
    JOIN blocks b ON b.id = f.parent_id
   WHERE f.workspace_id = ?
     AND f.deleted = 0
     AND f.is_field_form = 1
     AND f.parent_id > ?
     AND b.workspace_id = f.workspace_id
     AND b.deleted = 0
     AND NOT (${o})
   GROUP BY f.parent_id
   ORDER BY f.parent_id
   LIMIT ?`,l=`
  SELECT COUNT(*) AS n, COALESCE(MAX(b.updated_at), 0) AS t
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`,u=async(e,t)=>(await e(`SELECT COUNT(*) AS n
       FROM blocks b INDEXED BY idx_blocks_workspace_nonempty_properties
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND ${o}`,[t]))[0]?.n??0,d=new t(`property-cell-backfill`),f=e=>d.add(e),p=50,m=4,h=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await e.childrenOf(n.id,void 0)){let e=i.referenceTargetId;if(!i.isFieldForm||!e)continue;let n=t.resolveFieldSchema(e);n&&r.add(n.name)}return[...r]},g=async(e,t,n)=>{let r=new Set;for(let t of await e.childrenOf(n.id,void 0))t.isFieldForm&&t.referenceTargetId&&r.add(t.referenceTargetId);return Object.keys(n.properties).filter(e=>{let n=t.resolveNameSchema(e)?.fieldId;return n===void 0||!r.has(n)})},_=async(t,n,r,i,a,o)=>{let s={resolveNameSchema:n.resolveNameSchema};try{return await e(t,r,s,i),o(i.length),!0}catch{for(let n of i)try{await e(t,r,s,[n]),o(1)}catch(e){a(r.id,e)}return!1}},v=async(e,t,n,r,{deletesOnly:i})=>{let o=(e,t)=>{n.failureCount+=1,n.failures.length<p&&n.failures.push({blockId:e,reason:t instanceof Error?t.message:String(t)})},s=``,c=[];for(;;){if(c.length===0){if(c=await e.getAll(t,[e.workspaceId,s,a]),c.length===0)return;s=c[c.length-1].id}let l=[],u=0;for(;c.length>0&&(l.length===0||u+c[0].keys*2<=190);){let e=c.shift();l.push(e),u+=e.keys*2}let d=!1;if(await e.tx(async t=>{let r=await t.isPropertyChildBackedWorkspace(e.workspaceId);if(r&&i){d=!0;return}for(let{id:i}of l){n.blocksScanned+=1;let a=await t.get(i);a===null||a.deleted||await _(t,e,a,r?await g(t,e,a):await h(t,e,a),o,e=>{n.valuesMaterialized+=e})&&(n.blocksMaterialized+=1)}},{description:`Migrate properties to child blocks`}),d)return;await r()}},y=async(e,t)=>{let r={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1},i=async()=>{let t=await e.getAll(l,[e.workspaceId]);return{n:t[0]?.n??0,t:t[0]?.t??0}};for(;;){let a=await i();r.sweeps+=1,r.blocksScanned=0,r.blocksMaterialized=0,r.valuesMaterialized=0,r.failures=[],r.failureCount=0;let o=async()=>{await t?.(r)};await v(e,s,r,o,{deletesOnly:!1});let l=r.blocksScanned;await v(e,c,r,o,{deletesOnly:!0}),r.orphanedOwnersSwept+=r.blocksScanned-l;let u=await i();if(u.n===a.n){r.editedUnderPass=u.t!==a.t,await t?.(r);break}if(r.sweeps>=m)throw Error(`[${n}] gave up after ${m} sweeps: the workspace's property children kept changing, which means it is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return r},b=null,x=e=>{if(b?.workspaceId!==e)return null;let{progress:t}=b;return b=null,t},S={id:n,trigger:`operator`,run:async e=>{b=null;let t={blocksScanned:0,blocksMaterialized:0,valuesMaterialized:0,sweeps:0,orphanedOwnersSwept:0,failures:[],failureCount:0,editedUnderPass:!1};try{Object.assign(t,await y(e,e=>{Object.assign(t,e),console.info(`[${n}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),d.notify(e)}))}finally{b={workspaceId:e.workspaceId,progress:t}}t.failureCount>0&&console.warn(`[${n}] ${t.failureCount} property value(s) could not be migrated and kept their cell value:`,t.failures)}};export{s as CANDIDATE_SQL,n as PROPERTY_CELL_BACKFILL_ID,i as ROWS_PER_KEY,r as TARGET_INSERT_ROWS,u as countPropertyCellBackfillCandidates,f as onPropertyCellBackfillProgress,S as propertyCellBackfill,y as runPropertyCellBackfill,x as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map