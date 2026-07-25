import{normalizeReferences as e}from"../../data/api/blockData.js";import{ChangeScope as t}from"../../data/api/changeScope.js";import{definePostCommitProcessor as n}from"../../data/api/processor.js";import"../../data/api/index.js";import{aliasesProp as r}from"../../data/properties.js";import{readIsChildBackedWorkspace as i}from"../../data/workspaceSchema.js";import{computeAliasSeatId as a,generatedSeatFieldIds as o,matchesAliasSeatSeed as s}from"../../data/targets.js";import{rewriteWikilinks as c}from"./referenceParser.js";import{preferredSpanReplacement as l}from"./spanReplacement.js";var u=`references.renameBacklinks`,d=(e,t)=>`
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
         ) AS targetBlockingChildren`,f=e=>Math.max(e.targetCreatedAt,e.targetUserUpdatedAt??0),p=e=>Math.max(e.updatedAt,e.userUpdatedAt??0),m=(e,t,n,r)=>{let i=new Set;for(let n=0;n<64;n++)i.add(a(e,t,n));return{slotIds:i,mintedAfter:n,generatedFieldIds:r}},h=async(e,t,n)=>{if(n.length===0)return!1;let r=n.map(()=>`?`).join(`, `),i=await e.getAll(`SELECT id FROM blocks
     WHERE parent_id = ? AND deleted = 0 AND is_field_form = 1
       AND reference_target_id IN (${r})`,[t,...n]);for(let t of i){let n=await e.getAll(`SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0`,[t.id]);if(n.length>1||n.length===1&&await e.getOptional(`SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`,[n[0].id])!=null)return!0}return!1},g=e=>`
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         ${d(`target`,e)}
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND br.source_field = ''
    AND source.deleted = 0
    AND target.deleted = 0
`,_=e=>`
  SELECT ${d(`b`,e)}
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`,v=(e,t,n)=>{if(e.targetContent!==t||f(e)<=n.mintedAfter||e.targetBlockingChildren===1||!n.slotIds.has(e.targetId))return!1;let r;try{r=JSON.parse(e.targetProperties)}catch{return!1}return s({content:e.targetContent,properties:r})},y=async(e,t,n,r)=>v(t,n,r)&&!await h(e,t.targetId,r.generatedFieldIds),b=e=>{let t=e.properties[r.name];if(t===void 0)return[];try{return r.codec.decode(t)}catch{return[]}},x=(e,t,n,r)=>l({wikilinkAlias:t.length===1&&n.length===1?n[0]:null,pinLabel:e,targetId:r,context:u}),S=async(e,t,n,r)=>{let a=b(t),s=b(n),c=a.filter(e=>!s.includes(e));if(c.length===0)return;let l=s.filter(e=>!a.includes(e)),u=await i(e.db,n.workspaceId)?[...o(n.workspaceId)]:[];for(let t of c){let i=m(t,n.workspaceId,p(n),u),a=await e.db.getAll(_(u.length),[...u,n.workspaceId,t]),o=!1;for(let n of a)if(!await y(e.db,n,t,i)){o=!0;break}if(o)continue;let s=x(t,c,l,n.id);if(s===null)continue;let d=await e.db.getAll(g(u.length),[...u,n.workspaceId,t]);for(let a of d){if(a.targetId!==n.id&&!await y(e.db,a,t,i))continue;let o=r.get(a.sourceId);o===void 0&&(o={sourceId:a.sourceId,originalContent:a.sourceContent,rewrites:[]},r.set(a.sourceId,o)),o.rewrites.push({alias:t,replacement:s.text,fromTargetId:a.targetId,toTargetId:s.toTargetId??n.id,refAlias:s.refAlias,seat:i,pinned:s.toTargetId!==null})}}},C=(t,n)=>{if(n.length===0)return[...t];let r=new Map,i=(e,t)=>`${e}\u0000${t}`;for(let e of n)r.set(i(e.fromTargetId,e.alias),{id:e.toTargetId,alias:e.refAlias});let a=[];for(let e of t){if((e.sourceField??``)!==``){a.push(e);continue}let t=r.get(i(e.id,e.alias));if(t===void 0){let r=n.find(t=>t.alias===e.alias&&t.seat.slotIds.has(e.id));r!==void 0&&(t={id:r.toTargetId,alias:r.refAlias})}a.push(t===void 0?e:{...e,id:t.id,alias:t.alias})}return e(a)},w=async(e,t,n)=>t.id===n.toTargetId||!n.seat.slotIds.has(t.id)||t.content!==n.alias||!s(t)||Math.max(t.createdAt,t.userUpdatedAt)<=n.seat.mintedAfter?!1:!await T(e,t.id,n.seat.generatedFieldIds),T=async(e,t,n)=>{for(let r of await e.childrenOf(t)){let t=r.referenceTargetId??null;if(!(r.isFieldForm===!0&&t!==null&&n.includes(t)))return!0;let i=await e.childrenOf(r.id);if(i.length>1||i.length===1&&(await e.childrenOf(i[0].id)).length>0)return!0}return!1},E=(e,t,n,r)=>{let i=`${t}\u0000${n.alias}`,a=r.get(i);if(a!==void 0)return a;let o=(async()=>{let r=await e.aliasClaimants(n.alias,t);for(let t of r)if(!await w(e,t,n))return!1;return!0})();return r.set(i,o),o},D=async(e,t,n)=>{let r=await e.get(t.sourceId);if(r===null||r.deleted||r.content!==t.originalContent)return;let i=[];for(let a of t.rewrites)await E(e,r.workspaceId,a,n)&&i.push(a);if(i.length===0)return;let a=r.content;for(let e of i)a=c(a,e.alias,e.replacement,{skipEmbeds:e.pinned});if(a===r.content)return;let o=C(r.references,i);await e.update(t.sourceId,{content:a,references:o},{skipMetadata:!0})},O=(e,t)=>{let n=e.properties[r.name],i=t.properties[r.name];return JSON.stringify(n??null)!==JSON.stringify(i??null)},k=Promise.resolve(),A=e=>{let t=k.then(e);return k=t.then(()=>{},()=>{}),t},j=n({name:u,watches:{kind:`field`,table:`blocks`,fields:[`properties`]},apply:async(e,n)=>A(async()=>{let r=new Map;for(let t of e.changedRows)t.before===null||t.after===null||t.after.deleted||O(t.before,t.after)&&await S(n,t.before,t.after,r);r.size!==0&&await n.repo.tx(async e=>{let t=new Map;for(let n of r.values())await D(e,n,t)},{scope:t.References,description:`processor: ${u}`})})}),M=[j];export{u as RENAME_BACKLINKS_PROCESSOR,C as applyRefRewrites,h as hasDeepUserContent,v as isWindowMintedAliasSeat,j as renameBacklinksProcessor,M as renamePostCommitProcessors,x as replacementFor,m as seatClassificationCtx};
//# sourceMappingURL=renameProcessor.js.map