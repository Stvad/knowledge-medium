import{CORE_BLOCK_MERGED_EVENT as e}from"../api/events.js";import{defineSameTxProcessor as t}from"../api/sameTxProcessor.js";import"../api/index.js";import{setBlockTypesInProperties as n,typesProp as r}from"../properties.js";import"../blockTypes.js";import{typeMembershipTokenFor as i}from"../typeDefinitionMetadata.js";var a=`core.retargetMergedTypeMembership`,o=`
  SELECT bt.block_id AS id
  FROM block_types bt
  JOIN blocks b
    ON b.id = bt.block_id
   AND b.workspace_id = bt.workspace_id
  WHERE bt.type = ?
    AND bt.workspace_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at, b.id
`,s=`
  SELECT id
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 1
    AND properties_json LIKE ?
  ORDER BY created_at, id
`,c=(e,t)=>{let n=new Set([e]),r=t.get(e);for(;r!==void 0;){if(n.has(r))return null;n.add(r);let e=t.get(r);if(e===void 0)return r;r=e}return null},l=e=>{let t=e.properties[r.name];return t===void 0?[]:Array.isArray(t)&&t.every(e=>typeof e==`string`)?t:null},u=(e,t,n)=>{let r=Array.isArray(e)?e:[e],i=!1,a=Array.isArray(e),o=[],s=new Set;for(let e of r){if(typeof e!=`string`){a=!1;continue}let r=e===t?(i=!0,n):e;s.has(r)||(s.add(r),o.push(r))}return i?a?{outcome:`rewritten`,value:o}:{outcome:`undecodable`}:{outcome:`unchanged`}},d=async(e,t,d)=>{let f=c(e.fromId,t)??e.intoId,p=await d.tx.get(f);if(p===null||p.deleted)return;let m=i(p);if(m===e.fromId)return;let h=await d.tx.get(e.fromId);if(h===null)return;let g=l(h);if(g===null||!g.includes(`block-type`))return;let _=await d.db.getAll(o,[e.fromId,e.workspaceId]);_.push(...await d.db.getAll(s,[e.workspaceId,`%${JSON.stringify(e.fromId)}%`]));for(let{id:t}of _){let i=await d.tx.get(t);if(i===null)continue;let o=u(i.properties[r.name],e.fromId,m);if(o.outcome!==`unchanged`){if(o.outcome===`undecodable`){console.warn(`[${a}] block ${t} still tags the merged-away type ${e.fromId}, but its "types" cell is not a string list; left as-is — retargeting it would abort the merge (see rewriteTypeToken)`);continue}await d.tx.update(t,{properties:n(i.properties,o.value)},{skipMetadata:!0})}}},f=t({name:a,watches:{kind:`event`,events:[e]},apply:async(e,t)=>{let n=e.emittedEvents.map(e=>e.payload),r=new Map(n.map(e=>[e.fromId,e.intoId]));for(let e of n)await d(e,r,t)}}),p=[f];export{p as MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS,f as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,a as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME};
//# sourceMappingURL=mergeTypeMembershipProcessor.js.map