import{normalizeReferences as e}from"../../data/api/blockData.js";import{ChangeScope as t}from"../../data/api/changeScope.js";import{definePostCommitProcessor as n}from"../../data/api/processor.js";import"../../data/api/index.js";import{aliasesProp as r}from"../../data/properties.js";import{isAliasSeatSlotId as i,matchesAliasSeatSeed as a}from"../../data/targets.js";import{faithfulWikilinkReplacement as o,pinnedSpanReplacement as s,rewriteWikilinks as c}from"./referenceParser.js";var l=`references.renameBacklinks`,u=`
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         target.content AS targetContent,
         target.properties_json AS targetProperties,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = target.id AND child.deleted = 0
         ) AS targetHasLiveChildren
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`,d=`
  SELECT b.id AS targetId,
         b.content AS targetContent,
         b.properties_json AS targetProperties,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = b.id AND child.deleted = 0
         ) AS targetHasLiveChildren
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`,f=(e,t,n)=>{if(e.targetContent!==t||e.targetHasLiveChildren===1||!i(e.targetId,t,n))return!1;let r;try{r=JSON.parse(e.targetProperties)}catch{return!1}return a({content:e.targetContent,properties:r})},p=e=>{let t=e.properties[r.name];if(t===void 0)return[];try{return r.codec.decode(t)}catch{return[]}},m=(e,t,n,r)=>{if(t.length===1&&n.length===1){let e=o(n[0]);if(e!==null)return e}let i=s(e,r);return i===null?(console.warn(`[${l}] target "${r}" cannot be pinned (not UUID-shaped); leaving [[${e}]] spans unrewritten`),null):(i.lossyLabel&&console.warn(`[${l}] pinned span for alias "${e}" displays sanitized text (\`]\`/newline stripped, whitespace trimmed); link preserved`),i)},h=async(e,t,n,r)=>{let i=p(t),a=p(n),o=i.filter(e=>!a.includes(e));if(o.length===0)return;let s=a.filter(e=>!i.includes(e));for(let t of o){if((await e.db.getAll(d,[n.workspaceId,t])).some(e=>!f(e,t,n.workspaceId)))continue;let i=m(t,o,s,n.id);if(i===null)continue;let a=await e.db.getAll(u,[n.workspaceId,t]);for(let e of a){if(e.targetId!==n.id&&!f(e,t,n.workspaceId))continue;let a=r.get(e.sourceId);a===void 0&&(a={sourceId:e.sourceId,originalContent:e.sourceContent,rewrites:[]},r.set(e.sourceId,a)),a.rewrites.push({alias:t,replacement:i.text,fromTargetId:e.targetId,toTargetId:n.id,refAlias:i.refAlias})}}},g=(t,n)=>{if(n.length===0)return[...t];let r=new Map,i=(e,t)=>`${e}\u0000${t}`;for(let e of n)r.set(i(e.fromTargetId,e.alias),{id:e.toTargetId,alias:e.refAlias});let a=[];for(let e of t){if((e.sourceField??``)!==``){a.push(e);continue}let t=r.get(i(e.id,e.alias));a.push(t===void 0?e:{...e,id:t.id,alias:t.alias})}return e(a)},_=async(e,t)=>{let n=await e.get(t.sourceId);if(n===null||n.deleted||n.content!==t.originalContent)return;let r=n.content;for(let e of t.rewrites)r=c(r,e.alias,e.replacement);if(r===n.content)return;let i=g(n.references,t.rewrites);await e.update(t.sourceId,{content:r,references:i},{skipMetadata:!0})},v=(e,t)=>{let n=e.properties[r.name],i=t.properties[r.name];return JSON.stringify(n??null)!==JSON.stringify(i??null)},y=Promise.resolve(),b=e=>{let t=y.then(e);return y=t.then(()=>{},()=>{}),t},x=n({name:l,watches:{kind:`field`,table:`blocks`,fields:[`properties`]},apply:async(e,n)=>b(async()=>{let r=new Map;for(let t of e.changedRows)t.before===null||t.after===null||t.after.deleted||v(t.before,t.after)&&await h(n,t.before,t.after,r);r.size!==0&&await n.repo.tx(async e=>{for(let t of r.values())await _(e,t)},{scope:t.References,description:`processor: ${l}`})})}),S=[x];export{l as RENAME_BACKLINKS_PROCESSOR,g as applyRefRewrites,x as renameBacklinksProcessor,S as renamePostCommitProcessors,m as replacementFor};
//# sourceMappingURL=renameProcessor.js.map