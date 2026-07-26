import{normalizeReferences as e}from"../../data/api/blockData.js";import{ChangeScope as t}from"../../data/api/changeScope.js";import{definePostCommitProcessor as n}from"../../data/api/processor.js";import"../../data/api/index.js";import{aliasesProp as r}from"../../data/properties.js";import{readIsChildBackedWorkspace as i}from"../../data/workspaceSchema.js";import{computeAliasSeatId as a,generatedSeatFieldIds as o,matchesAliasSeatSeed as s}from"../../data/targets.js";import{parseReferences as c,rewriteWikilinksMulti as l}from"./referenceParser.js";import{preferredSpanReplacement as u}from"./spanReplacement.js";var d=`references.renameBacklinks`,f=(e,t)=>`
         ${e}.id AS targetId,
         ${e}.content AS targetContent,
         ${e}.properties_json AS targetProperties,
         ${e}.created_at AS targetCreatedAt,
         ${e}.user_updated_at AS targetUserUpdatedAt,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = ${e}.id
             AND child.deleted = 0
             AND (child.is_field_form IS NOT 1
                  OR child.reference_target_id IS NULL
                  OR child.reference_target_id NOT IN (${Array.from({length:t},()=>`?`).join(`, `)}))
         ) AS targetBlockingChildren`,p=e=>Math.max(e.targetCreatedAt,e.targetUserUpdatedAt??0),m=e=>Math.max(e.updatedAt,e.userUpdatedAt??0),h=(e,t,n,r)=>{let i=new Set;for(let n=0;n<64;n++)i.add(a(e,t,n));return{slotIds:i,mintedAfter:n,generatedFieldIds:r}},g=async(e,t,n)=>{if(n.length===0)return!1;let r=n.map(()=>`?`).join(`, `),i=await e.getAll(`SELECT id, reference_target_id FROM blocks
     WHERE parent_id = ? AND deleted = 0 AND is_field_form = 1
       AND reference_target_id IN (${r})`,[t,...n]),a=new Set;for(let e of i){if(a.has(e.reference_target_id))return!0;a.add(e.reference_target_id)}for(let t of i){let n=await e.getAll(`SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0`,[t.id]);if(n.length>1||n.length===1&&await e.getOptional(`SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`,[n[0].id])!=null)return!0}return!1},_=e=>`
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         ${f(`target`,e)}
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND br.source_field = ''
    AND source.deleted = 0
    AND target.deleted = 0
`,v=e=>`
  SELECT ${f(`b`,e)}
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`,y=(e,t,n)=>{if(e.targetContent!==t||p(e)<=n.mintedAfter||e.targetBlockingChildren===1||!n.slotIds.has(e.targetId))return!1;let r;try{r=JSON.parse(e.targetProperties)}catch{return!1}return s({content:e.targetContent,properties:r})},b=async(e,t,n,r)=>y(t,n,r)&&!await g(e,t.targetId,r.generatedFieldIds),x=e=>{let t=e.properties[r.name];if(t===void 0)return[];try{return r.codec.decode(t)}catch{return[]}},S=(e,t,n,r)=>u({wikilinkAlias:t.length===1&&n.length===1?n[0]:null,pinLabel:e,targetId:r,context:d}),C=(e,t,n)=>{let r=e.get(t);if(r!==void 0)return r;let i={sourceId:t,originalContent:n,rewrites:[],staleEdges:[]};return e.set(t,i),i},w=async(e,t,n,r,i,a)=>{let o=await e.db.getAll(_(r),[...i,t.workspaceId,n]);for(let e of o)e.targetId===t.id&&C(a,e.sourceId,e.sourceContent).staleEdges.push({alias:n,targetId:e.targetId})},T=async(e,t,n,r)=>{let a=x(t),s=x(n),c=a.filter(e=>!s.includes(e));if(c.length===0)return;let l=s.filter(e=>!a.includes(e)),u=await i(e.db,n.workspaceId)?[...o(n.workspaceId)]:[];for(let t of c){let i=h(t,n.workspaceId,m(n),u),a=await e.db.getAll(v(u.length),[...u,n.workspaceId,t]),o=!1;for(let n of a)if(!await b(e.db,n,t,i)){o=!0;break}if(o){await w(e,n,t,u.length,u,r);continue}let s=S(t,c,l,n.id);if(s===null){await w(e,n,t,u.length,u,r);continue}let d=await e.db.getAll(_(u.length),[...u,n.workspaceId,t]);for(let e of d)e.targetId===n.id&&C(r,e.sourceId,e.sourceContent).rewrites.push({alias:t,replacement:s.text,fromTargetId:e.targetId,toTargetId:s.toTargetId??n.id,refAlias:s.refAlias,seat:i,pinned:s.toTargetId!==null})}},E=(t,n,r=new Set)=>{if(n.length===0)return[...t];let i=new Map,a=(e,t)=>`${e}\u0000${t}`;for(let e of n)i.set(a(e.fromTargetId,e.alias),{id:e.toTargetId,alias:e.refAlias});let o=[];for(let e of t){if((e.sourceField??``)!==``){o.push(e);continue}let t=i.get(a(e.id,e.alias));if(t===void 0){let r=n.find(t=>t.alias===e.alias&&t.seat.slotIds.has(e.id));r!==void 0&&(t={id:r.toTargetId,alias:r.refAlias})}if(t===void 0){o.push(e);continue}r.has(e.alias)&&o.push(e),o.push({...e,id:t.id,alias:t.alias})}return e(o)},D=async(e,t,n)=>t.id===n.toTargetId||!n.seat.slotIds.has(t.id)||t.content!==n.alias||!s(t)||Math.max(t.createdAt,t.userUpdatedAt)<=n.seat.mintedAfter?!1:!await O(e,t.id,n.seat.generatedFieldIds),O=async(e,t,n)=>{let r=new Set;for(let i of await e.childrenOf(t)){let t=i.referenceTargetId??null;if(!(i.isFieldForm===!0&&t!==null&&n.includes(t))||r.has(t))return!0;r.add(t);let a=await e.childrenOf(i.id);if(a.length>1||a.length===1&&(await e.childrenOf(a[0].id)).length>0)return!0}return!1},k=(e,t,n,r)=>{let i=[t,n.alias,n.toTargetId,n.seat.mintedAfter].join(`\0`),a=r.get(i);if(a!==void 0)return a;let o=(async()=>{let r=await e.aliasClaimants(n.alias,t);for(let t of r)if(!await D(e,t,n))return!1;return!0})();return r.set(i,o),o},A=async(t,n,r)=>{let i=await t.get(n.sourceId);if(i===null||i.deleted||i.content!==n.originalContent)return;let a=[];for(let e of n.rewrites)await k(t,i.workspaceId,e,r)&&a.push(e);if(a.length===0&&n.staleEdges.length===0)return;let o=l(i.content,new Map(a.map(e=>[e.alias,{text:e.replacement,skipEmbeds:e.pinned}]))),s=new Set(c(o).map(e=>e.alias)),u=new Set(a.filter(e=>e.pinned&&s.has(e.alias)).map(e=>e.alias)),d=E(i.references,a,u);n.staleEdges.length>0&&(d=e(d.filter(e=>(e.sourceField??``)!==``||!n.staleEdges.some(t=>t.alias===e.alias&&t.targetId===e.id))));let f=o!==i.content,p=JSON.stringify(d)!==JSON.stringify(e([...i.references]));!f&&!p||await t.update(n.sourceId,f?{content:o,references:d}:{references:d},{skipMetadata:!0})},j=(e,t)=>{let n=e.properties[r.name],i=t.properties[r.name];return JSON.stringify(n??null)!==JSON.stringify(i??null)},M=Promise.resolve(),N=e=>{let t=M.then(e);return M=t.then(()=>{},()=>{}),t},P=n({name:d,watches:{kind:`field`,table:`blocks`,fields:[`properties`]},apply:async(e,n)=>N(async()=>{let r=new Map;for(let t of e.changedRows)t.before===null||t.after===null||t.after.deleted||j(t.before,t.after)&&await T(n,t.before,t.after,r);r.size!==0&&await n.repo.tx(async e=>{let t=new Map;for(let n of r.values())await A(e,n,t)},{scope:t.References,description:`processor: ${d}`})})}),F=[P];export{d as RENAME_BACKLINKS_PROCESSOR,E as applyRefRewrites,g as hasDeepUserContent,y as isWindowMintedAliasSeat,P as renameBacklinksProcessor,F as renamePostCommitProcessors,S as replacementFor,h as seatClassificationCtx};
//# sourceMappingURL=renameProcessor.js.map