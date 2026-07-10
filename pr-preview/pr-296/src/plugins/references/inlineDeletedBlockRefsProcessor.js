import{normalizeReferences as e}from"../../data/api/blockData.js";import{CORE_BLOCK_DELETED_EVENT as t}from"../../data/api/events.js";import{defineSameTxProcessor as n}from"../../data/api/sameTxProcessor.js";import"../../data/api/index.js";import{inlineBlockRefs as r}from"./referenceParser.js";var i=`references.inlineDeletedBlockReferences`,a=`
  SELECT DISTINCT br.source_id AS id
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`,o=(e,t)=>e.id===t&&e.alias===t&&e.sourceField===void 0,s=(e,t,n,i)=>{let a=n.get(e);if(a!==void 0)return a;let o=t.get(e)??``;if(i.has(e))return o;i.add(e);let c=o;for(let a of t.keys())a!==e&&(c=r(c,a,s(a,t,n,i)));return i.delete(e),n.set(e,c),c},c=async(t,n,i,a)=>{let s=await t.get(n);if(s===null||s.deleted)return;let c=r(s.content,i,a),l=e(s.references.filter(e=>!o(e,i))),u={};c!==s.content&&(u.content=c),JSON.stringify(l)!==JSON.stringify(s.references)&&(u.references=l),Object.keys(u).length!==0&&await t.update(s.id,u,{skipMetadata:!0})},l=n({name:i,watches:{kind:`event`,events:[t]},apply:async(e,t)=>{let n=new Map,r=new Map;for(let i of e.emittedEvents){let{blockId:e,workspaceId:a}=i.payload,o=await t.tx.get(e);n.set(e,o?.content??``),r.set(e,a)}let i=new Map;for(let[e,o]of r){let r=await t.db.getAll(a,[o,e]);if(r.length===0)continue;let l=s(e,n,i,new Set);for(let{id:n}of r)await c(t.tx,n,e,l)}}});export{i as INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR,l as inlineDeletedBlockRefsProcessor};
//# sourceMappingURL=inlineDeletedBlockRefsProcessor.js.map