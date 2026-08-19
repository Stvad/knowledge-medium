import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";import{CallbackSet as t}from"../../utils/callbackSet.js";var n=`properties:cell-to-children`,r=190,i=2,a=500,o=`
  SELECT b.id AS id,
         (SELECT COUNT(*) FROM json_each(b.properties_json)) AS keys
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.properties_json <> '{}'
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))
   ORDER BY b.id
   LIMIT ?`,s=`
  SELECT COUNT(*) AS n
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`,c=async(e,t)=>(await e(`SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND b.properties_json <> '{}'
        AND json_valid(b.properties_json)
        AND json_type(b.properties_json) = 'object'
        AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,[t]))[0]?.n??0,l=new t(`property-cell-backfill`),u=e=>l.add(e),d=50,f=4,p=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await e.childrenOf(n.id,void 0)){let e=i.referenceTargetId;if(!i.isFieldForm||!e)continue;let n=t.resolveFieldSchema(e);n&&r.add(n.name)}return[...r]},m=async(t,n,r,i,a)=>{let o={resolveNameSchema:n.resolveNameSchema};try{return await e(t,r,o,i),!0}catch{for(let n of i)try{await e(t,r,o,[n])}catch(e){a(r.id,e)}return!1}},h=async(e,t,s)=>{let c=(e,n)=>{t.failureCount+=1,t.failures.length<d&&t.failures.push({blockId:e,reason:n instanceof Error?n.message:String(n)})},l=``,u=[];for(;;){if(u.length===0){if(u=await e.getAll(o,[e.workspaceId,l,a]),u.length===0)return;l=u[u.length-1].id}let d=[],f=0;for(;u.length>0&&(d.length===0||f+u[0].keys*i<=r);){let e=u.shift();d.push(e),f+=e.keys*i}await e.tx(async r=>{if(await r.isPropertyChildBackedWorkspace(e.workspaceId))throw Error(`[${n}] aborting: workspace ${e.workspaceId} is already child-backed. This pass materializes children FROM cells, so past the flip it would overwrite authoritative value rows with a derived bag.`);for(let{id:n}of d){t.blocksScanned+=1;let i=await r.get(n);i===null||i.deleted||await m(r,e,i,await p(r,e,i),c)&&(t.blocksMaterialized+=1)}},{description:`Migrate properties to child blocks`}),await s()}},g=async(e,t)=>{let r={blocksScanned:0,blocksMaterialized:0,sweeps:0,failures:[],failureCount:0},i=async()=>(await e.getAll(s,[e.workspaceId]))[0]?.n??0;for(;;){let a=await i();if(r.sweeps+=1,r.blocksScanned=0,r.blocksMaterialized=0,r.failures=[],r.failureCount=0,await h(e,r,async()=>{await t?.(r)}),await i()===a)break;if(r.sweeps>=f)throw Error(`[${n}] gave up after ${f} sweeps: blocks kept gaining property children, which means the workspace is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return r},_=null,v=e=>{if(_?.workspaceId!==e)return null;let{progress:t}=_;return _=null,t},y={id:n,trigger:`operator`,run:async e=>{_=null;let t=await g(e,e=>{console.info(`[${n}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),l.notify(e)});_={workspaceId:e.workspaceId,progress:t},t.failureCount>0&&console.warn(`[${n}] ${t.failureCount} property value(s) could not be migrated and kept their cell value:`,t.failures)}};export{o as CANDIDATE_SQL,n as PROPERTY_CELL_BACKFILL_ID,c as countPropertyCellBackfillCandidates,u as onPropertyCellBackfillProgress,y as propertyCellBackfill,g as runPropertyCellBackfill,v as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map