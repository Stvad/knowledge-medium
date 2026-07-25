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
         ) AS targetBlockingChildren`,f=e=>Math.max(e.targetCreatedAt,e.targetUserUpdatedAt??0),p=e=>Math.max(e.updatedAt,e.userUpdatedAt??0),m=(e,t,n)=>{let r=new Set;for(let n=0;n<64;n++)r.add(a(e,t,n));return{slotIds:r,mintedAfter:n}},h=e=>`
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
`,g=e=>`
  SELECT ${d(`b`,e)}
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`,_=(e,t,n)=>{if(e.targetContent!==t||f(e)<n.mintedAfter||e.targetBlockingChildren===1||!n.slotIds.has(e.targetId))return!1;let r;try{r=JSON.parse(e.targetProperties)}catch{return!1}return s({content:e.targetContent,properties:r})},v=e=>{let t=e.properties[r.name];if(t===void 0)return[];try{return r.codec.decode(t)}catch{return[]}},y=(e,t,n,r)=>l({wikilinkAlias:t.length===1&&n.length===1?n[0]:null,pinLabel:e,targetId:r,context:u}),b=async(e,t,n,r)=>{let a=v(t),s=v(n),c=a.filter(e=>!s.includes(e));if(c.length===0)return;let l=s.filter(e=>!a.includes(e)),u=await i(e.db,n.workspaceId)?[...o(n.workspaceId)]:[];for(let t of c){let i=m(t,n.workspaceId,p(n));if((await e.db.getAll(g(u.length),[...u,n.workspaceId,t])).some(e=>!_(e,t,i)))continue;let a=y(t,c,l,n.id);if(a===null)continue;let o=await e.db.getAll(h(u.length),[...u,n.workspaceId,t]);for(let e of o){if(e.targetId!==n.id&&!_(e,t,i))continue;let o=r.get(e.sourceId);o===void 0&&(o={sourceId:e.sourceId,originalContent:e.sourceContent,rewrites:[]},r.set(e.sourceId,o)),o.rewrites.push({alias:t,replacement:a.text,fromTargetId:e.targetId,toTargetId:a.toTargetId??n.id,refAlias:a.refAlias,seatIds:i.slotIds,pinned:a.toTargetId!==null})}}},x=(t,n)=>{if(n.length===0)return[...t];let r=new Map,i=(e,t)=>`${e}\u0000${t}`;for(let e of n)r.set(i(e.fromTargetId,e.alias),{id:e.toTargetId,alias:e.refAlias});let a=[];for(let e of t){if((e.sourceField??``)!==``){a.push(e);continue}let t=r.get(i(e.id,e.alias));if(t===void 0){let r=n.find(t=>t.alias===e.alias&&t.seatIds.has(e.id));r!==void 0&&(t={id:r.toTargetId,alias:r.refAlias})}a.push(t===void 0?e:{...e,id:t.id,alias:t.alias})}return e(a)},S=(e,t,n,r)=>{let i=`${t}\u0000${n.alias}`,a=r.get(i);if(a!==void 0)return a;let o=(async()=>(await e.aliasClaimants(n.alias,t)).every(e=>e.id!==n.toTargetId&&n.seatIds.has(e.id)&&e.content===n.alias&&s(e)))();return r.set(i,o),o},C=async(e,t,n)=>{let r=await e.get(t.sourceId);if(r===null||r.deleted||r.content!==t.originalContent)return;let i=[];for(let a of t.rewrites)await S(e,r.workspaceId,a,n)&&i.push(a);if(i.length===0)return;let a=r.content;for(let e of i)a=c(a,e.alias,e.replacement,{skipEmbeds:e.pinned});if(a===r.content)return;let o=x(r.references,i);await e.update(t.sourceId,{content:a,references:o},{skipMetadata:!0})},w=(e,t)=>{let n=e.properties[r.name],i=t.properties[r.name];return JSON.stringify(n??null)!==JSON.stringify(i??null)},T=Promise.resolve(),E=e=>{let t=T.then(e);return T=t.then(()=>{},()=>{}),t},D=n({name:u,watches:{kind:`field`,table:`blocks`,fields:[`properties`]},apply:async(e,n)=>E(async()=>{let r=new Map;for(let t of e.changedRows)t.before===null||t.after===null||t.after.deleted||w(t.before,t.after)&&await b(n,t.before,t.after,r);r.size!==0&&await n.repo.tx(async e=>{let t=new Map;for(let n of r.values())await C(e,n,t)},{scope:t.References,description:`processor: ${u}`})})}),O=[D];export{u as RENAME_BACKLINKS_PROCESSOR,x as applyRefRewrites,D as renameBacklinksProcessor,O as renamePostCommitProcessors,y as replacementFor};
//# sourceMappingURL=renameProcessor.js.map