import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{seedKeyProp as ee}from"../properties.js";import{SYSTEM_BLOCK_TYPES as d,USER_TYPE as f}from"../blockTypes.js";import{userStateRootBlockIds as p}from"../derivedIds.js";import{propertyDefinitionBlockId as te}from"../definitionSeeds.js";import{SELECT_BLOCK_COLUMNS_SQL as ne,buildQualifiedBlockColumnsSql as m}from"../blockSchema.js";import{ANCESTORS_SQL as re,CHILDREN_IDS_SQL as ie,CHILDREN_SQL as ae,SUBTREE_SQL as oe,VISIBLE_CHILDREN_IDS_SQL as se,VISIBLE_CHILDREN_SQL as h,VISIBLE_SUBTREE_SQL as ce,manyAncestorsSql as g}from"./treeQueries.js";import{assertAncestorWalkBounded as le,buildCandidatesCte as ue,compileTypedBlockQuery as _,isSelectiveWhereValue as v,normalizeTypedBlockQuery as y}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as b,KERNEL_CONTENT_CHANNEL as x,TYPED_BLOCKS_LIVE_CHANNEL as de,TYPED_BLOCKS_PROPERTY_CHANNEL as fe,TYPED_BLOCKS_REFERENCE_CHANNEL as pe,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as me,TYPED_BLOCKS_STRUCTURE_CHANNEL as S,TYPED_BLOCKS_TYPE_CHANNEL as he,kernelAliasesKey as C,kernelContentKey as w,typedBlocksLiveKey as T,typedBlocksPropertyKey as ge,typedBlocksReferenceFieldKey as _e,typedBlocksReferenceKey as ve,typedBlocksStructureKey as E,typedBlocksTypeKey as D}from"../invalidation.js";var ye=`
  SELECT ${ne}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,O=`
  SELECT ${m(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,be=3,k=e=>`"${e.replace(/"/g,`""`)}"`,A=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},xe=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},j=e=>e.trim().length>=be,M=e=>{let t=A(e.trim());return j(t)?{matchQuery:k(t),rankQuery:t}:null},N=e=>{let t=e.trim();if(!j(t))return null;let n=xe(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&j(e.text)),i=A(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],ee=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},d=e=>j(e)?(ee(k(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!d(e.op))return M(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!d(e.op))return M(t);continue}if(!l&&!d(e.op))return M(t);continue}if(e.excluded&&!r){if(!d(`-${e.text}`))return M(t);continue}if(c){if(j(e.text))o.push(k(e.text));else return M(t);c=!1,s=!1;continue}if(e.excluded&&r){if(j(e.text))o.push(k(e.text));else return M(t);s=!1;continue}if(!d(e.text))return M(t)}let f=a.filter(e=>e.length>0);if(f.length===0&&j(i))return M(t);if(f.length===0)return null;let p=f.length===1?f[0].join(` `):`(${f.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?p:`${p} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},P=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),F=`
  SELECT ${m(`b`)}
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY
    CASE
      WHEN LOWER(b.content) = LOWER(?) THEN 0
      WHEN LOWER(b.content) LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    coalesce(b.user_updated_at, b.updated_at) DESC
  LIMIT ?
`,I=`
  SELECT ${ne}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`,L=`
  SELECT block_id AS id FROM block_types
   WHERE workspace_id = ? AND type = ?
`,R=`
  WITH RECURSIVE user_state(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT b.id FROM blocks b
      JOIN user_state ON b.parent_id = user_state.id
  )
  SELECT ${m(`blocks`)}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.content != ''
    AND blocks.id NOT IN (SELECT id FROM user_state)
    AND json_extract(blocks.properties_json, '$."${ee.name}"') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM block_types bt
       WHERE bt.block_id = blocks.id
         AND bt.type IN (${d.map(()=>`?`).join(`, `)})
    )
  ORDER BY coalesce(blocks.user_updated_at, blocks.updated_at) DESC, blocks.id ASC
  LIMIT ?
`,z=(e,t,n)=>[JSON.stringify(e),t,...d,n],B=`
  SELECT ba.alias AS alias
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  GROUP BY ba.alias
  ORDER BY
    MIN(CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END),
    MIN(b.created_at),
    ba.alias
`,V=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,Se=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
`,Ce=`
  SELECT ${m(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,H=e=>`
    SELECT
      ba.alias AS alias,
      b.id AS blockId,
      b.content AS content,
      coalesce(b.user_updated_at, b.updated_at) AS updatedAt
    FROM block_aliases ba
    JOIN blocks b ON b.id = ba.block_id
    WHERE ba.workspace_id = ?
      AND b.deleted = 0
      AND (${e>0?Array(e).fill(`ba.alias_lower LIKE '%' || ? || '%' ESCAPE '\\'`).join(` AND `):`1=1`})
    ORDER BY
      CASE
        WHEN ba.alias_lower = ? THEN 0
        WHEN ba.alias_lower LIKE ? || '%' ESCAPE '\\' THEN 1
        ELSE 2
      END,
      b.created_at,
      ba.alias
    LIMIT ?
  `,U=`
  SELECT
    ba.alias AS alias,
    b.id AS blockId,
    b.content AS content
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  ORDER BY
    CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    b.created_at,
    ba.alias
  LIMIT ?
`,we=`
  SELECT ${m(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,W=e=>e,G={parse:e=>e},Te={parse:e=>e},Ee={parse:e=>e},De={parse:e=>e},Oe=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(ce,[e,...K(n.repo)]):await n.db.getAll(oe,[e]),i=n.hydrateBlocks(W(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),ke=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:G,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(re,[e,e]);return t.hydrateBlocks(W(n))}}),Ae=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(g(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(W(r.get(e)??[]))}))}}),je=new WeakMap,K=e=>{let t=e.propertyDefinitions;if(!t)return[`[]`,``];let n=je.get(t);if(n)return n;let r=[];for(let e of t.seedsByKey.keys())r.push(te(t.workspaceId,e));let i=[JSON.stringify(r),t.workspaceId];return je.set(t,i),i},Me=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:G,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(h,[e,...K(n.repo)]):await n.db.getAll(ae,[e]);return n.hydrateBlocks(W(r))}}),Ne=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(se,[e,...K(r.repo)]):await r.db.getAll(ie,[e])).map(e=>e.id);let i=n?await r.db.getAll(h,[e,...K(r.repo)]):await r.db.getAll(ae,[e]);return r.hydrateBlocks(W(i),{declareRowDeps:!1}).map(e=>e.id)}}),Pe=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:G,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:he,key:D(e,t)});let r=await n.db.getAll(O,[e,t]);return n.hydrateBlocks(W(r))}}),q=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),Fe=e=>`
  WITH RECURSIVE
    ${e},
    walk(anc_id, anc_parent_id, depth, path) AS (
      SELECT seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
      FROM candidates c
      JOIN blocks seed ON seed.id = c.id
      WHERE seed.deleted = 0
      UNION ALL
      SELECT
        parent.id,
        parent.parent_id,
        walk.depth + 1,
        walk.path || '!' || hex(parent.id) || '/'
      FROM walk
      JOIN blocks parent ON parent.id = walk.anc_parent_id
      WHERE parent.deleted = 0
        AND walk.depth < 100
        AND INSTR(walk.path, '!' || hex(parent.id) || '/') = 0
    )
  SELECT DISTINCT anc_id FROM walk
`,J=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:fe,key:ge(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(v)||n.depend({kind:`plugin`,channel:de,key:T(t)}),J(s,t,n)}},Ie=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:me,key:_e(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:pe,key:ve(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:S,key:E(t,e.id)})},Le=(e,t,n)=>{for(let r of e)J(r.where,t,n),r.referencedBy!==void 0&&Ie(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},Y=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:he,key:D(n,e)});J(e.where,n,t),i!==void 0&&Ie(i,n,t),Le(a,n,t),Le(o,n,t);let s=Object.values(e.where??{}).some(v),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(v));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:de,key:T(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},X=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Z=async(e,t,n)=>{le(e);let r=ue(e,t.repo.propertySchemas),i=await t.db.getAll(Fe(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:S,key:E(e.workspaceId,r.anc_id)})},Re=async(e,t)=>{if(!e.workspaceId)return[];let n=y(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=Y(n,t);if(X(o,s)&&await Z(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(O,[r,i[0]]);return t.hydrateBlocks(W(e))}let c=_(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(W(l))},ze=async(e,t)=>{if(!e.workspaceId)return[];let n=y(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=_(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Be=e({name:`core.typedBlocks`,argsSchema:q,resultSchema:G,resolve:(e,t)=>Re(e,t)}),Ve=e({name:`core.typedBlockIds`,argsSchema:q,resultSchema:Te,resolve:(e,t)=>ze(e,t)}),He=async(e,t)=>{if(!e.workspaceId)return 0;let n=y(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=_(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},Q=e({name:`core.typedBlockCount`,argsSchema:q,resultSchema:Ee,resolve:(e,t)=>He(e,t)}),Ue=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:G,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=N(t);if(i===null)return[];r.depend({kind:`plugin`,channel:x,key:w(e)});let a=await r.db.getAll(F,[e,i.matchQuery,i.rankQuery,P(i.rankQuery),n]);return r.hydrateBlocks(W(a),{declareRowDeps:!1})}}),We=async(e,t)=>(await e.db.getAll(L,[t,f])).flatMap(e=>p(e.id)),Ge=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:G,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:x,key:w(e)});let r=await n.db.getAll(I,[e,t]);return n.hydrateBlocks(W(r),{declareRowDeps:!1})}}),Ke=e({name:`core.recentActivity`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:{parse:e=>e},resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:x,key:w(e)});let r=await n.db.getAll(R,z(await We(n,e),e,t)),i=n.hydrateBlocks(W(r),{declareRowDeps:!1});if(i.length===0)return[];let a=await n.db.getAll(g(i.length),i.map(e=>e.id)),o=new Map;for(let e of i)o.set(e.id,[]);for(let e of a)o.get(e.chain_start_id)?.push(e);return i.map(t=>{let r=n.hydrateBlocks(W(o.get(t.id)??[]),{declareRowDeps:!1});for(let i of[t,...r])n.depend({kind:`plugin`,channel:S,key:E(e,i.id)});return{block:t,ancestors:r}})}}),qe=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:De,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(ie,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(we,[e,t]);return i===null?null:n.hydrateBlocks(W([i]),{declareRowDeps:!1})[0]??null}}),Je=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:b,key:C(e)});let r=P(t);return(await n.db.getAll(B,[e,t,r,t,r])).map(e=>e.alias)}}),Ye=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:b,key:C(e)});let i=P(t),a=await r.db.getAll(U,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),Xe=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:b,key:C(e)});let a=H(t.length),o=n.toLowerCase(),s=[e,...t.map(P),o,P(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),Ze=e({name:`core.blockTypesByIds`,argsSchema:a({workspaceId:s(),blockIds:n(s()).max(200)}),resultSchema:n(a({blockId:s(),type:s()})),resolve:async({workspaceId:e,blockIds:t},n)=>{if(!e||t.length===0)return[];for(let e of t)n.depend({kind:`row`,id:e});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${r})
         AND json_type(b.properties_json, '$.types') = 'array'
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,[e,...t])}}),Qe=e({name:`core.aliasClaimantCounts`,argsSchema:a({workspaceId:s(),aliases:n(s()).max(200)}),resultSchema:n(a({alias:s(),claimants:i()})),resolve:async({workspaceId:e,aliases:t},n)=>{if(!e||t.length===0)return[];n.depend({kind:`plugin`,channel:b,key:C(e)});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT ba.alias AS alias, count(*) AS claimants
       FROM block_aliases ba
       JOIN blocks b ON b.id = ba.block_id
       WHERE ba.workspace_id = ?
         AND ba.alias IN (${r})
         AND b.deleted = 0
       GROUP BY ba.alias`,[e,...t])}}),$e=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:De,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:b,key:C(e)});let r=await n.db.getOptional(V,[e,t]);return r===null?null:n.hydrateBlocks(W([r]))[0]??null}}),$=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:G,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(O,[e,`extension`]);return t.hydrateBlocks(W(n))}}),et=[Oe,ke,Ae,Me,Ne,Pe,Be,Ve,Q,Ue,Ge,Ke,qe,Je,Ye,Xe,Ze,Qe,$e,$];export{et as KERNEL_QUERIES,B as SELECT_ALIASES_IN_WORKSPACE_SQL,U as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,Se as SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL,F as SELECT_BLOCKS_BY_CONTENT_SQL,O as SELECT_BLOCKS_BY_TYPE_SQL,Ce as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,V as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,ye as SELECT_BLOCK_BY_ID_SQL,we as SELECT_FIRST_CHILD_BY_CONTENT_SQL,I as SELECT_RECENT_BLOCKS_SQL,R as SELECT_RECENT_USER_BLOCKS_SQL,L as SELECT_USER_PAGE_IDS_SQL,Qe as aliasClaimantCountsQuery,$e as aliasLookupQuery,Xe as aliasMatchesFuzzyQuery,Ye as aliasMatchesQuery,Je as aliasesInWorkspaceQuery,ke as ancestorsQuery,Ze as blockTypesByIdsQuery,H as buildFuzzyAliasMatchesSql,Pe as byTypeQuery,Ne as childIdsQuery,Me as childrenQuery,N as compileBlocksContentSearchQuery,$ as findExtensionBlocksQuery,qe as firstChildByContentQuery,Ae as manyAncestorsQuery,Ke as recentActivityQuery,Ge as recentBlocksQuery,z as recentUserBlocksParams,He as resolveTypedBlockCount,ze as resolveTypedBlockIds,Re as resolveTypedBlocks,Ue as searchByContentQuery,Oe as subtreeQuery,Q as typedBlockCountQuery,Ve as typedBlockIdsQuery,Be as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map