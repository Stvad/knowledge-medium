import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";import{CallbackSet as t}from"../../utils/callbackSet.js";var n=`properties:cell-to-children`,r=100,i=`
  SELECT b.id AS id
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.deleted = 0
     AND b.id > ?
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND EXISTS (SELECT 1 FROM json_each(b.properties_json))
   ORDER BY b.id
   LIMIT ?`,a=`
  SELECT COUNT(*) AS n, COALESCE(MAX(b.updated_at), 0) AS t
    FROM blocks b
   WHERE b.workspace_id = ? AND b.deleted = 0
     AND (b.is_field_form = 1
          OR EXISTS (SELECT 1 FROM blocks f
                      WHERE f.id = b.parent_id AND f.is_field_form = 1
                        AND f.workspace_id = b.workspace_id))`,o=async(e,t)=>(await e(`SELECT COUNT(*) AS n FROM blocks b
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND json_valid(b.properties_json)
        AND json_type(b.properties_json) = 'object'
        AND EXISTS (SELECT 1 FROM json_each(b.properties_json))`,[t]))[0]?.n??0,s=new t(`property-cell-backfill`),c=e=>s.add(e),l=50,u=4,d=class extends Error{},f=async(e,t,n)=>{let r=new Set(Object.keys(n.properties));for(let i of await e.childrenOf(n.id,void 0)){let e=i.referenceTargetId;if(!i.isFieldForm||!e)continue;let n=t.resolveFieldSchema(e);n&&r.add(n.name)}return[...r]},p=async(t,r,a,o)=>{let s=``;for(;;){let c=await t.getAll(i,[t.workspaceId,s,100]);if(c.length===0)return;s=c[c.length-1].id,await t.tx(async i=>{if(await i.isPropertyChildBackedWorkspace(t.workspaceId))throw Error(`[${n}] aborting: workspace ${t.workspaceId} is already child-backed. This pass materializes children FROM cells, so past the flip it would overwrite authoritative value rows with a derived bag.`);for(let{id:n}of c){r.blocksScanned+=1;let o=await i.get(n);if(!(o===null||o.deleted))try{await e(i,o,{resolveNameSchema:t.resolveNameSchema},await f(i,t,o)),r.blocksMaterialized+=1}catch(e){a.value+=1,r.failures.length<l&&r.failures.push({blockId:n,reason:e instanceof Error?e.message:String(e)})}}},{description:`Migrate properties to child blocks`}),await o()}},m=async(e,t)=>{let r={blocksScanned:0,blocksMaterialized:0,sweeps:0,failures:[]},i={value:0},o=async()=>{let t=await e.getAll(a,[e.workspaceId]);return`${t[0]?.n??0}:${t[0]?.t??0}`};for(;;){let a=await o();if(r.sweeps+=1,await p(e,r,i,async()=>{await t?.(r)}),await o()===a)break;if(r.sweeps>=u)throw new d(`[${n}] gave up after ${u} sweeps: blocks kept gaining property children, which means the workspace is being edited faster than the pass runs. Nothing is lost — run it again when the workspace is idle. Completion was NOT recorded.`)}return i.value>r.failures.length&&r.failures.push({blockId:`(truncated)`,reason:`${i.value-r.failures.length} further blocks failed; only the first ${l} are listed.`}),r},h=null,g=e=>{if(h?.workspaceId!==e)return null;let{progress:t}=h;return h=null,t},_={id:n,trigger:`operator`,run:async e=>{h=null;let t=await m(e,e=>{console.info(`[${n}] sweep ${e.sweeps}: ${e.blocksMaterialized}/${e.blocksScanned} blocks`),s.notify(e)});h={workspaceId:e.workspaceId,progress:t},t.failures.length>0&&console.warn(`[${n}] ${t.failures.length} block(s) could not be migrated and kept cell-only values:`,t.failures)}};export{r as PROPERTY_CELL_BACKFILL_BATCH,n as PROPERTY_CELL_BACKFILL_ID,o as countPropertyCellBackfillCandidates,c as onPropertyCellBackfillProgress,_ as propertyCellBackfill,m as runPropertyCellBackfill,g as takeLastPropertyCellBackfillRun};
//# sourceMappingURL=propertyCellBackfill.js.map