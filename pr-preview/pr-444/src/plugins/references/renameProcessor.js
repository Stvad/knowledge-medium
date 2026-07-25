import{normalizeReferences as e}from"../../data/api/blockData.js";import{ChangeScope as t}from"../../data/api/changeScope.js";import{definePostCommitProcessor as n}from"../../data/api/processor.js";import"../../data/api/index.js";import{aliasesProp as r}from"../../data/properties.js";import{computeAliasSeatId as i,generatedSeatFieldIds as a,matchesAliasSeatSeed as o}from"../../data/targets.js";import{rewriteWikilinks as s}from"./referenceParser.js";import{preferredSpanReplacement as c}from"./spanReplacement.js";var l=`references.renameBacklinks`,u=e=>`
         ${e}.id AS targetId,
         ${e}.content AS targetContent,
         ${e}.properties_json AS targetProperties,
         ${e}.created_at AS targetCreatedAt,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = ${e}.id
             AND child.deleted = 0
             AND (child.reference_target_id IS NULL
                  OR child.reference_target_id NOT IN (?, ?))
         ) AS targetBlockingChildren`,d=(e,t,n)=>{let r=new Set;for(let n=0;n<64;n++)r.add(i(e,t,n));return{slotIds:r,mintedAfter:n}},f=`
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         ${u(`target`)}
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND br.source_field = ''
    AND source.deleted = 0
    AND target.deleted = 0
`,p=`
  SELECT ${u(`b`)}
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`,m=(e,t,n)=>{if(e.targetContent!==t||e.targetCreatedAt<n.mintedAfter||e.targetBlockingChildren===1||!n.slotIds.has(e.targetId))return!1;let r;try{r=JSON.parse(e.targetProperties)}catch{return!1}return o({content:e.targetContent,properties:r})},h=e=>{let t=e.properties[r.name];if(t===void 0)return[];try{return r.codec.decode(t)}catch{return[]}},g=(e,t,n,r)=>c({wikilinkAlias:t.length===1&&n.length===1?n[0]:null,pinLabel:e,targetId:r,context:l}),_=async(e,t,n,r)=>{let i=h(t),o=h(n),s=i.filter(e=>!o.includes(e));if(s.length===0)return;let c=o.filter(e=>!i.includes(e)),[l,u]=[...a(n.workspaceId)];for(let t of s){let i=d(t,n.workspaceId,n.userUpdatedAt);if((await e.db.getAll(p,[l,u,n.workspaceId,t])).some(e=>!m(e,t,i)))continue;let a=g(t,s,c,n.id);if(a===null)continue;let o=await e.db.getAll(f,[l,u,n.workspaceId,t]);for(let e of o){if(e.targetId!==n.id&&!m(e,t,i))continue;let o=r.get(e.sourceId);o===void 0&&(o={sourceId:e.sourceId,originalContent:e.sourceContent,rewrites:[]},r.set(e.sourceId,o)),o.rewrites.push({alias:t,replacement:a.text,fromTargetId:e.targetId,toTargetId:a.toTargetId??n.id,refAlias:a.refAlias,seatIds:i.slotIds})}}},v=(t,n)=>{if(n.length===0)return[...t];let r=new Map,i=(e,t)=>`${e}\u0000${t}`;for(let e of n)r.set(i(e.fromTargetId,e.alias),{id:e.toTargetId,alias:e.refAlias});let a=[];for(let e of t){if((e.sourceField??``)!==``){a.push(e);continue}let t=r.get(i(e.id,e.alias));a.push(t===void 0?e:{...e,id:t.id,alias:t.alias})}return e(a)},y=async(e,t,n,r)=>{let i=await e.aliasLookup(n,t);return i===null?!0:r.has(i.id)},b=async(e,t)=>{let n=await e.get(t.sourceId);if(n===null||n.deleted||n.content!==t.originalContent)return;let r=[];for(let i of t.rewrites)await y(e,n.workspaceId,i.alias,i.seatIds)&&r.push(i);if(r.length===0)return;let i=n.content;for(let e of r)i=s(i,e.alias,e.replacement);if(i===n.content)return;let a=v(n.references,r);await e.update(t.sourceId,{content:i,references:a},{skipMetadata:!0})},x=(e,t)=>{let n=e.properties[r.name],i=t.properties[r.name];return JSON.stringify(n??null)!==JSON.stringify(i??null)},S=Promise.resolve(),C=e=>{let t=S.then(e);return S=t.then(()=>{},()=>{}),t},w=n({name:l,watches:{kind:`field`,table:`blocks`,fields:[`properties`]},apply:async(e,n)=>C(async()=>{let r=new Map;for(let t of e.changedRows)t.before===null||t.after===null||t.after.deleted||x(t.before,t.after)&&await _(n,t.before,t.after,r);r.size!==0&&await n.repo.tx(async e=>{for(let t of r.values())await b(e,t)},{scope:t.References,description:`processor: ${l}`})})}),T=[w];export{l as RENAME_BACKLINKS_PROCESSOR,v as applyRefRewrites,w as renameBacklinksProcessor,T as renamePostCommitProcessors,g as replacementFor};
//# sourceMappingURL=renameProcessor.js.map