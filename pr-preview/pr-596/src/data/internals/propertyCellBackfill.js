import{materializePropertyChildrenForExistingRow as e}from"./propertyChildrenProcessor.js";import{CallbackSet as t}from"../../utils/callbackSet.js";var n=`properties:cell-to-children`,r=100,i=`
    b.deleted = 0
     AND json_valid(b.properties_json)
     AND json_type(b.properties_json) = 'object'
     AND (SELECT COUNT(*) FROM json_each(b.properties_json)) >
         (SELECT COUNT(*) FROM blocks c
           WHERE c.parent_id = b.id
             AND c.workspace_id = b.workspace_id
             AND c.deleted = 0
             AND c.is_field_form = 1)`,a=`
  SELECT b.id AS id
    FROM blocks b
   WHERE b.workspace_id = ?
     AND b.id > ?
     AND ${i}
   ORDER BY b.id
   LIMIT ?`,o=async(e,t)=>(await e(`SELECT COUNT(*) AS n FROM blocks b WHERE b.workspace_id = ? AND ${i}`,[t]))[0]?.n??0,s=new t(`property-cell-backfill`),c=e=>s.add(e),l=50,u=async(t,n)=>{let r={blocksScanned:0,blocksMaterialized:0,failures:[]},i=0,o=``;for(;;){let s=await t.getAll(a,[t.workspaceId,o,100]);if(s.length===0)break;o=s[s.length-1].id,await t.tx(async n=>{for(let{id:a}of s){r.blocksScanned+=1;let o=await n.get(a);if(!(o===null||o.deleted))try{await e(n,o,{resolveNameSchema:t.resolveNameSchema}),r.blocksMaterialized+=1}catch(e){i+=1,r.failures.length<l&&r.failures.push({blockId:a,reason:e instanceof Error?e.message:String(e)})}}},{description:`Migrate properties to child blocks`}),n?.(r)}return i>r.failures.length&&r.failures.push({blockId:`(truncated)`,reason:`${i-r.failures.length} further blocks failed; only the first ${l} are listed.`}),r},d={id:n,trigger:`operator`,run:async e=>{let t=await u(e,e=>{console.info(`[${n}] ${e.blocksMaterialized}/${e.blocksScanned} blocks`),s.notify(e)});t.failures.length>0&&console.warn(`[${n}] ${t.failures.length} block(s) could not be migrated and kept cell-only values:`,t.failures)}};export{r as PROPERTY_CELL_BACKFILL_BATCH,n as PROPERTY_CELL_BACKFILL_ID,o as countPropertyCellBackfillCandidates,c as onPropertyCellBackfillProgress,d as propertyCellBackfill,u as runPropertyCellBackfill};
//# sourceMappingURL=propertyCellBackfill.js.map