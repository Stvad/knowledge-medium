import{CORE_BLOCK_MERGED_EVENT as e}from"../api/events.js";import{defineSameTxProcessor as t}from"../api/sameTxProcessor.js";import"../api/index.js";import{hasBlockType as n,setBlockTypesInProperties as r,typesProp as i}from"../properties.js";import"../blockTypes.js";import{typeMembershipTokenFor as a}from"../typeDefinitionMetadata.js";var o=`core.retargetMergedTypeMembership`,s=`
  SELECT bt.block_id AS id
  FROM block_types bt
  JOIN blocks b
    ON b.id = bt.block_id
   AND b.workspace_id = bt.workspace_id
  WHERE bt.type = ?
    AND bt.workspace_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at, b.id
`,c=`
  SELECT id
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 1
    AND properties_json LIKE ?
  ORDER BY created_at, id
`,l=(e,t)=>{let n=new Set([e]),r=t.get(e);for(;r!==void 0;){if(n.has(r))return null;n.add(r);let e=t.get(r);if(e===void 0)return r;r=e}return null},u=(e,t,n)=>{let r=Array.isArray(e)?e:[e],i=!1,a=Array.isArray(e),o=[],s=new Set;for(let e of r){if(typeof e!=`string`){a=!1;continue}let r=e===t?(i=!0,n):e;s.has(r)||(s.add(r),o.push(r))}return i?a?{outcome:`rewritten`,value:o}:{outcome:`undecodable`}:{outcome:`unchanged`}},d=async(e,t,d)=>{let f=l(e.fromId,t)??e.intoId,p=await d.tx.get(f);if(p===null||p.deleted)return;let m=a(p);if(m===e.fromId)return;let h=await d.db.getAll(s,[e.fromId,e.workspaceId]),g=await d.tx.get(e.fromId);if(g!==null&&n(g,`block-type`)){let t=await d.db.getAll(c,[e.workspaceId,`%${JSON.stringify(e.fromId)}%`]);h.push(...t)}for(let{id:t}of h){let n=await d.tx.get(t);if(n===null)continue;let a=u(n.properties[i.name],e.fromId,m);if(a.outcome!==`unchanged`){if(a.outcome===`undecodable`){console.warn(`[${o}] block ${t} still tags the merged-away type ${e.fromId}, but its "types" cell is not a string list; left as-is — retargeting it would abort the merge (see rewriteTypeToken)`);continue}await d.tx.update(t,{properties:r(n.properties,a.value)},{skipMetadata:!0})}}},f=t({name:o,watches:{kind:`event`,events:[e]},apply:async(e,t)=>{let n=e.emittedEvents.map(e=>e.payload),r=new Map(n.map(e=>[e.fromId,e.intoId]));for(let e of n)await d(e,r,t)}}),p=[f];export{p as MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS,f as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,o as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME};
//# sourceMappingURL=mergeTypeMembershipProcessor.js.map