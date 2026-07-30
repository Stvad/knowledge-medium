import{CORE_BLOCK_MERGED_EVENT as e}from"../api/events.js";import{defineSameTxProcessor as t}from"../api/sameTxProcessor.js";import"../api/index.js";import{setBlockTypesInProperties as n,typesProp as r}from"../properties.js";import{typeMembershipTokenFor as i}from"../typeDefinitionMetadata.js";var a=`core.retargetMergedTypeMembership`,o=`
  SELECT bt.block_id AS id
  FROM block_types bt
  JOIN blocks b
    ON b.id = bt.block_id
   AND b.workspace_id = bt.workspace_id
  WHERE bt.type = ?
    AND bt.workspace_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at, b.id
`,s=(e,t,n)=>{let r=Array.isArray(e)?e:[e],i=!1,a=Array.isArray(e),o=[],s=new Set;for(let e of r){if(typeof e!=`string`){a=!1;continue}let r=e===t?(i=!0,n):e;s.has(r)||(s.add(r),o.push(r))}return i?a?{outcome:`rewritten`,value:o}:{outcome:`undecodable`}:{outcome:`unchanged`}},c=async(e,t)=>{let c=await t.tx.get(e.intoId);if(c===null||c.deleted)return;let l=i(c);if(l===e.fromId)return;let u=await t.db.getAll(o,[e.fromId,e.workspaceId]);for(let{id:i}of u){let o=await t.tx.get(i);if(o===null||o.deleted)continue;let c=s(o.properties[r.name],e.fromId,l);if(c.outcome!==`unchanged`){if(c.outcome===`undecodable`){console.warn(`[${a}] block ${i} still tags the merged-away type ${e.fromId}, but its "types" cell is not a string list; left as-is — retargeting it would abort the merge (see rewriteTypeToken)`);continue}await t.tx.update(i,{properties:n(o.properties,c.value)},{skipMetadata:!0})}}},l=t({name:a,watches:{kind:`event`,events:[e]},apply:async(e,t)=>{for(let n of e.emittedEvents)await c(n.payload,t)}}),u=[l];export{u as MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS,l as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,a as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME};
//# sourceMappingURL=mergeTypeMembershipProcessor.js.map