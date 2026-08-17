import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{seedKeyProp as ee}from"../properties.js";import{userStateRootBlockIds as d}from"../derivedIds.js";import{SYSTEM_BLOCK_TYPES as f,USER_TYPE as p}from"../blockTypes.js";import{SELECT_BLOCK_COLUMNS_SQL as m,buildQualifiedBlockColumnsSql as h}from"../blockSchema.js";import{ANCESTORS_SQL as te,CHILDREN_IDS_SQL as ne,CHILDREN_SQL as re,SUBTREE_SQL as ie,VISIBLE_CHILDREN_IDS_SQL as ae,VISIBLE_CHILDREN_SQL as g,VISIBLE_SUBTREE_SQL as oe,manyAncestorsSql as _}from"./treeQueries.js";import{assertAncestorWalkBounded as se,buildCandidatesCte as ce,compileTypedBlockQuery as v,isSelectiveWhereValue as y,normalizeTypedBlockQuery as b}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as x,KERNEL_CONTENT_CHANNEL as S,TYPED_BLOCKS_LIVE_CHANNEL as le,TYPED_BLOCKS_PROPERTY_CHANNEL as ue,TYPED_BLOCKS_REFERENCE_CHANNEL as de,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as fe,TYPED_BLOCKS_STRUCTURE_CHANNEL as C,TYPED_BLOCKS_TYPE_CHANNEL as w,kernelAliasesKey as T,kernelContentKey as E,typedBlocksLiveKey as D,typedBlocksPropertyKey as pe,typedBlocksReferenceFieldKey as me,typedBlocksReferenceKey as he,typedBlocksStructureKey as O,typedBlocksTypeKey as k}from"../invalidation.js";var ge=`
  SELECT ${m}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,A=`
  SELECT ${h(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,_e=3,j=e=>`"${e.replace(/"/g,`""`)}"`,M=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},ve=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},N=e=>e.trim().length>=_e,P=e=>{let t=M(e.trim());return N(t)?{matchQuery:j(t),rankQuery:t}:null},F=e=>{let t=e.trim();if(!N(t))return null;let n=ve(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&N(e.text)),i=M(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],ee=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},d=e=>N(e)?(ee(j(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!d(e.op))return P(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!d(e.op))return P(t);continue}if(!l&&!d(e.op))return P(t);continue}if(e.excluded&&!r){if(!d(`-${e.text}`))return P(t);continue}if(c){if(N(e.text))o.push(j(e.text));else return P(t);c=!1,s=!1;continue}if(e.excluded&&r){if(N(e.text))o.push(j(e.text));else return P(t);s=!1;continue}if(!d(e.text))return P(t)}let f=a.filter(e=>e.length>0);if(f.length===0&&N(i))return P(t);if(f.length===0)return null;let p=f.length===1?f[0].join(` `):`(${f.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?p:`${p} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},I=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),L=`
  SELECT ${h(`b`)}
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
`,R=`
  SELECT ${m}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`,z=`
  SELECT block_id AS id FROM block_types
   WHERE workspace_id = ? AND type = ?
`,B=`
  WITH RECURSIVE user_state(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT b.id FROM blocks b
      JOIN user_state ON b.parent_id = user_state.id
  )
  SELECT ${h(`blocks`)}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.content != ''
    AND blocks.id NOT IN (SELECT id FROM user_state)
    AND json_extract(blocks.properties_json, '$."${ee.name}"') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM block_types bt
       WHERE bt.block_id = blocks.id
         AND bt.type IN (${f.map(()=>`?`).join(`, `)})
    )
  ORDER BY coalesce(blocks.user_updated_at, blocks.updated_at) DESC, blocks.id ASC
  LIMIT ?
`,V=(e,t,n)=>[JSON.stringify(e),t,...f,n],H=`
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
`,U=`
  SELECT ${h(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,ye=`
  SELECT ${h(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
`,be=`
  SELECT ${h(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,W=e=>`
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
  `,G=`
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
`,xe=`
  SELECT ${h(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,K=e=>e,q={parse:e=>e},Se={parse:e=>e},Ce={parse:e=>e},we={parse:e=>e},Te=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(oe,[e]):await n.db.getAll(ie,[e]),i=n.hydrateBlocks(K(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),Ee=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:q,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(te,[e,e]);return t.hydrateBlocks(K(n))}}),De=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(_(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(K(r.get(e)??[]))}))}}),Oe=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:q,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(g,[e]):await n.db.getAll(re,[e]);return n.hydrateBlocks(K(r))}}),ke=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(ae,[e]):await r.db.getAll(ne,[e])).map(e=>e.id);let i=n?await r.db.getAll(g,[e]):await r.db.getAll(re,[e]);return r.hydrateBlocks(K(i),{declareRowDeps:!1}).map(e=>e.id)}}),Ae=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:q,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:w,key:k(e,t)});let r=await n.db.getAll(A,[e,t]);return n.hydrateBlocks(K(r))}}),J=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),je=e=>`
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
`,Y=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:ue,key:pe(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(y)||n.depend({kind:`plugin`,channel:le,key:D(t)}),Y(s,t,n)}},Me=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:fe,key:me(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:de,key:he(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:C,key:O(t,e.id)})},Ne=(e,t,n)=>{for(let r of e)Y(r.where,t,n),r.referencedBy!==void 0&&Me(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},X=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:w,key:k(n,e)});Y(e.where,n,t),i!==void 0&&Me(i,n,t),Ne(a,n,t),Ne(o,n,t);let s=Object.values(e.where??{}).some(y),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(y));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:le,key:D(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},Z=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Q=async(e,t,n)=>{se(e);let r=ce(e,t.repo.propertySchemas),i=await t.db.getAll(je(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:C,key:O(e.workspaceId,r.anc_id)})},Pe=async(e,t)=>{if(!e.workspaceId)return[];let n=b(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=X(n,t);if(Z(o,s)&&await Q(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(A,[r,i[0]]);return t.hydrateBlocks(K(e))}let c=v(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(K(l))},Fe=async(e,t)=>{if(!e.workspaceId)return[];let n=b(e),{matchPredicates:r,excludePredicates:i}=X(n,t);Z(r,i)&&await Q(n,t,`structure`);let a=v(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Ie=e({name:`core.typedBlocks`,argsSchema:J,resultSchema:q,resolve:(e,t)=>Pe(e,t)}),Le=e({name:`core.typedBlockIds`,argsSchema:J,resultSchema:Se,resolve:(e,t)=>Fe(e,t)}),Re=async(e,t)=>{if(!e.workspaceId)return 0;let n=b(e),{matchPredicates:r,excludePredicates:i}=X(n,t);Z(r,i)&&await Q(n,t,`structure`);let a=v(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},ze=e({name:`core.typedBlockCount`,argsSchema:J,resultSchema:Ce,resolve:(e,t)=>Re(e,t)}),Be=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:q,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=F(t);if(i===null)return[];r.depend({kind:`plugin`,channel:S,key:E(e)});let a=await r.db.getAll(L,[e,i.matchQuery,i.rankQuery,I(i.rankQuery),n]);return r.hydrateBlocks(K(a),{declareRowDeps:!1})}}),Ve=async(e,t)=>(await e.db.getAll(z,[t,p])).flatMap(e=>d(e.id)),$=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:q,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:S,key:E(e)});let r=await n.db.getAll(R,[e,t]);return n.hydrateBlocks(K(r),{declareRowDeps:!1})}}),He=e({name:`core.recentActivity`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:{parse:e=>e},resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:S,key:E(e)});let r=await n.db.getAll(B,V(await Ve(n,e),e,t)),i=n.hydrateBlocks(K(r),{declareRowDeps:!1});if(i.length===0)return[];let a=await n.db.getAll(_(i.length),i.map(e=>e.id)),o=new Map;for(let e of i)o.set(e.id,[]);for(let e of a)o.get(e.chain_start_id)?.push(e);return i.map(e=>({block:e,ancestors:n.hydrateBlocks(K(o.get(e.id)??[]),{declareRowDeps:!1})}))}}),Ue=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:we,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(ne,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(xe,[e,t]);return i===null?null:n.hydrateBlocks(K([i]),{declareRowDeps:!1})[0]??null}}),We=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:x,key:T(e)});let r=I(t);return(await n.db.getAll(H,[e,t,r,t,r])).map(e=>e.alias)}}),Ge=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:x,key:T(e)});let i=I(t),a=await r.db.getAll(G,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),Ke=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:x,key:T(e)});let a=W(t.length),o=n.toLowerCase(),s=[e,...t.map(I),o,I(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),qe=e({name:`core.blockTypesByIds`,argsSchema:a({workspaceId:s(),blockIds:n(s()).max(200)}),resultSchema:n(a({blockId:s(),type:s()})),resolve:async({workspaceId:e,blockIds:t},n)=>{if(!e||t.length===0)return[];for(let e of t)n.depend({kind:`row`,id:e});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${r})
         AND json_type(b.properties_json, '$.types') = 'array'
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,[e,...t])}}),Je=e({name:`core.aliasClaimantCounts`,argsSchema:a({workspaceId:s(),aliases:n(s()).max(200)}),resultSchema:n(a({alias:s(),claimants:i()})),resolve:async({workspaceId:e,aliases:t},n)=>{if(!e||t.length===0)return[];n.depend({kind:`plugin`,channel:x,key:T(e)});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT ba.alias AS alias, count(*) AS claimants
       FROM block_aliases ba
       JOIN blocks b ON b.id = ba.block_id
       WHERE ba.workspace_id = ?
         AND ba.alias IN (${r})
         AND b.deleted = 0
       GROUP BY ba.alias`,[e,...t])}}),Ye=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:we,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:x,key:T(e)});let r=await n.db.getOptional(U,[e,t]);return r===null?null:n.hydrateBlocks(K([r]))[0]??null}}),Xe=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:q,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(A,[e,`extension`]);return t.hydrateBlocks(K(n))}}),Ze=[Te,Ee,De,Oe,ke,Ae,Ie,Le,ze,Be,$,He,Ue,We,Ge,Ke,qe,Je,Ye,Xe];export{Ze as KERNEL_QUERIES,H as SELECT_ALIASES_IN_WORKSPACE_SQL,G as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,ye as SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL,L as SELECT_BLOCKS_BY_CONTENT_SQL,A as SELECT_BLOCKS_BY_TYPE_SQL,be as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,U as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,ge as SELECT_BLOCK_BY_ID_SQL,xe as SELECT_FIRST_CHILD_BY_CONTENT_SQL,R as SELECT_RECENT_BLOCKS_SQL,B as SELECT_RECENT_USER_BLOCKS_SQL,z as SELECT_USER_PAGE_IDS_SQL,Je as aliasClaimantCountsQuery,Ye as aliasLookupQuery,Ke as aliasMatchesFuzzyQuery,Ge as aliasMatchesQuery,We as aliasesInWorkspaceQuery,Ee as ancestorsQuery,qe as blockTypesByIdsQuery,W as buildFuzzyAliasMatchesSql,Ae as byTypeQuery,ke as childIdsQuery,Oe as childrenQuery,F as compileBlocksContentSearchQuery,Xe as findExtensionBlocksQuery,Ue as firstChildByContentQuery,De as manyAncestorsQuery,He as recentActivityQuery,$ as recentBlocksQuery,V as recentUserBlocksParams,Re as resolveTypedBlockCount,Fe as resolveTypedBlockIds,Pe as resolveTypedBlocks,Be as searchByContentQuery,Te as subtreeQuery,ze as typedBlockCountQuery,Le as typedBlockIdsQuery,Ie as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map