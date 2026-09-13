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
    AND properties_json LIKE ? ESCAPE '\\'
  ORDER BY created_at, id
`,c=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),l=async(e,t,n)=>{let r=new Set([e]),i=t.get(e);for(;i!==void 0;){if(r.has(i))return null;r.add(i);let e=t.get(i);if(e===void 0||!await n(i))return i;i=e}return null},u=e=>{let t=e.properties[r.name];return t===void 0?[]:Array.isArray(t)&&t.every(e=>typeof e==`string`)?t:null},d=(e,t,n)=>{let r=Array.isArray(e)?e:[e],i=!1,a=Array.isArray(e),o=[],s=new Set;for(let e of r){if(typeof e!=`string`){a=!1;continue}let r=e===t?(i=!0,n):e;s.has(r)||(s.add(r),o.push(r))}return i?a?{outcome:`rewritten`,value:o}:{outcome:`undecodable`}:{outcome:`unchanged`}},f=(e,t,n)=>e.typesById.has(t)&&e.blockIdByTypeId.get(t)!==n,p=async(e,t,p)=>{let m=await l(e.fromId,t,async e=>(await p.tx.get(e))?.deleted===!0)??e.intoId,h=await p.tx.get(m);if(h===null||h.deleted)return;let g=i(h);if(g===e.fromId)return;let _=p.typeDefinitions;if(_===null){console.warn(`[${a}] no type registry for workspace ${e.workspaceId}; leaving membership on the merged-away ${e.fromId} rather than retargeting unverified`);return}if(f(_,g,h.id))return;let v=await p.tx.get(e.fromId);if(v===null||!v.deleted)return;let y=u(v);if(y===null||!y.includes(`block-type`)||f(_,e.fromId,v.id))return;let b=await p.db.getAll(o,[e.fromId,e.workspaceId]);b.push(...await p.db.getAll(s,[e.workspaceId,`%${c(JSON.stringify(e.fromId))}%`]));for(let{id:t}of b){let i=await p.tx.get(t);if(i===null)continue;let o=d(i.properties[r.name],e.fromId,g);if(o.outcome!==`unchanged`){if(o.outcome===`undecodable`){console.warn(`[${a}] block ${t} still tags the merged-away type ${e.fromId}, but its "types" cell is not a string list; left as-is — retargeting it would abort the merge (see rewriteTypeToken)`);continue}await p.tx.update(t,{properties:n(i.properties,o.value)},{skipMetadata:!0})}}},m=t({name:a,watches:{kind:`event`,events:[e]},apply:async(e,t)=>{let n=e.emittedEvents.map(e=>e.payload),r=new Map(n.map(e=>[e.fromId,e.intoId]));for(let e of n)await p(e,r,t)}}),h=[m];export{h as MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS,m as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,a as RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME};
//# sourceMappingURL=mergeTypeMembershipProcessor.js.map