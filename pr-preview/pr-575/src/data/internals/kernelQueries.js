import{defineQuery as e}from"../api/query.js";import{_enum as t,array as n,boolean as r,number as i,object as a,record as o,string as s,unknown as c}from"../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js";import{blockPredicateSchema as l,referenceFilterSchema as u}from"../api/typedBlockQuery.js";import"../api/index.js";import{seedKeyProp as d}from"../properties.js";import{userStateRootBlockIds as f}from"../derivedIds.js";import{SYSTEM_BLOCK_TYPES as p,USER_TYPE as m}from"../blockTypes.js";import{SELECT_BLOCK_COLUMNS_SQL as h,buildQualifiedBlockColumnsSql as g}from"../blockSchema.js";import{ANCESTORS_SQL as ee,CHILDREN_IDS_SQL as te,CHILDREN_SQL as ne,SUBTREE_SQL as re,VISIBLE_CHILDREN_IDS_SQL as ie,VISIBLE_CHILDREN_SQL as _,VISIBLE_SUBTREE_SQL as ae,manyAncestorsSql as v}from"./treeQueries.js";import{assertAncestorWalkBounded as oe,buildCandidatesCte as se,compileTypedBlockQuery as y,isSelectiveWhereValue as b,normalizeTypedBlockQuery as x}from"./typedBlockQuery.js";import{KERNEL_ALIASES_CHANNEL as S,KERNEL_CONTENT_CHANNEL as C,TYPED_BLOCKS_LIVE_CHANNEL as ce,TYPED_BLOCKS_PROPERTY_CHANNEL as le,TYPED_BLOCKS_REFERENCE_CHANNEL as ue,TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL as de,TYPED_BLOCKS_STRUCTURE_CHANNEL as w,TYPED_BLOCKS_TYPE_CHANNEL as fe,kernelAliasesKey as T,kernelContentKey as E,typedBlocksLiveKey as D,typedBlocksPropertyKey as pe,typedBlocksReferenceFieldKey as me,typedBlocksReferenceKey as he,typedBlocksStructureKey as O,typedBlocksTypeKey as k}from"../invalidation.js";var ge=`
  SELECT ${h}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`,A=`
  SELECT ${g(`b`)}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`,_e=3,j=e=>`"${e.replace(/"/g,`""`)}"`,M=e=>{let t=e.trim();return t.length>=2&&t.startsWith(`"`)&&t.endsWith(`"`)?t.slice(1,-1):t},ve=e=>{let t=[],n=0,r=(e,n)=>{let r=e.trim();if(r){if(!n&&(r===`AND`||r===`OR`||r===`NOT`)){t.push({kind:`operator`,op:r});return}t.push({kind:`term`,text:r,excluded:n})}};for(;n<e.length;){for(;n<e.length&&/\s/.test(e[n]??``);)n++;if(n>=e.length)break;let t=!1;if(e[n]===`-`&&n+1<e.length&&!/\s/.test(e[n+1]??``)&&(t=!0,n++),e[n]===`"`){n++;let i=n;for(;n<e.length&&e[n]!==`"`;)n++;r(e.slice(i,n),t),e[n]===`"`&&n++;continue}let i=n;for(;n<e.length&&!/\s/.test(e[n]??``);)n++;r(e.slice(i,n),t)}return t},N=e=>e.trim().length>=_e,P=e=>{let t=M(e.trim());return N(t)?{matchQuery:j(t),rankQuery:t}:null},F=e=>{let t=e.trim();if(!N(t))return null;let n=ve(t),r=n.some(e=>e.kind===`term`&&!e.excluded&&N(e.text)),i=M(t),a=[[]],o=[],s=!1,c=!1,l=!1,u=()=>a[a.length-1],d=e=>{s&&u().length>0&&a.push([]),u().push(e),l=!0,s=!1,c=!1},f=e=>N(e)?(d(j(e)),!0):!1;for(let e of n){if(e.kind===`operator`){if(e.op===`OR`){if(l)s=!0;else if(!f(e.op))return P(t);continue}if(e.op===`NOT`){if(l||r)c=!0;else if(!f(e.op))return P(t);continue}if(!l&&!f(e.op))return P(t);continue}if(e.excluded&&!r){if(!f(`-${e.text}`))return P(t);continue}if(c){if(N(e.text))o.push(j(e.text));else return P(t);c=!1,s=!1;continue}if(e.excluded&&r){if(N(e.text))o.push(j(e.text));else return P(t);s=!1;continue}if(!f(e.text))return P(t)}let p=a.filter(e=>e.length>0);if(p.length===0&&N(i))return P(t);if(p.length===0)return null;let m=p.length===1?p[0].join(` `):`(${p.map(e=>e.join(` `)).join(` OR `)})`;return{matchQuery:o.length===0?m:`${m} ${o.map(e=>`NOT ${e}`).join(` `)}`,rankQuery:i}},I=e=>e.replace(/[\\%_]/g,e=>`\\${e}`),L=`
  SELECT ${g(`b`)}
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
  SELECT ${h}
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
  SELECT ${g(`blocks`)}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.content != ''
    AND blocks.id NOT IN (SELECT id FROM user_state)
    AND json_extract(blocks.properties_json, '$."${d.name}"') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM block_types bt
       WHERE bt.block_id = blocks.id
         AND bt.type IN (${p.map(()=>`?`).join(`, `)})
    )
  ORDER BY coalesce(blocks.user_updated_at, blocks.updated_at) DESC, blocks.id ASC
  LIMIT ?
`,V=(e,t,n)=>[JSON.stringify(e),t,...p,n],H=`
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
  SELECT ${g(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`,ye=`
  SELECT ${g(`blocks`)}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
`,be=`
  SELECT ${g(`blocks`)}
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
  `,xe=`
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
`,Se=`
  SELECT ${g(`child`)}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`,G=e=>e,K={parse:e=>e},Ce={parse:e=>e},we={parse:e=>e},Te={parse:e=>e},Ee=e({name:`core.subtree`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:{parse:e=>e},resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`row`,id:e}),n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(ae,[e]):await n.db.getAll(re,[e]),i=n.hydrateBlocks(G(r)).map((e,t)=>({...e,depth:r[t].depth}));for(let e of i)n.depend({kind:`parent-edge`,parentId:e.id});return i}}),De=e({name:`core.ancestors`,argsSchema:a({id:s()}),resultSchema:K,resolve:async({id:e},t)=>{t.depend({kind:`row`,id:e});let n=await t.db.getAll(ee,[e,e]);return t.hydrateBlocks(G(n))}}),Oe=e({name:`core.manyAncestors`,argsSchema:a({ids:n(s()).readonly()}),resultSchema:{parse:e=>e},resolve:async({ids:e},t)=>{if(e.length===0)return[];for(let n of e)t.depend({kind:`row`,id:n});let n=await t.db.getAll(v(e.length),[...e]),r=new Map;for(let t of e)r.set(t,[]);for(let e of n){let t=r.get(e.chain_start_id);t&&t.push(e)}return e.map(e=>({startId:e,ancestors:t.hydrateBlocks(G(r.get(e)??[]))}))}}),ke=e({name:`core.children`,argsSchema:a({id:s(),hidePropertyChildren:r().optional()}),resultSchema:K,resolve:async({id:e,hidePropertyChildren:t=!1},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=t?await n.db.getAll(_,[e]):await n.db.getAll(ne,[e]);return n.hydrateBlocks(G(r))}}),Ae=e({name:`core.childIds`,argsSchema:a({id:s(),hydrate:r().optional(),hidePropertyChildren:r().optional()}),resultSchema:n(s()),resolve:async({id:e,hydrate:t=!1,hidePropertyChildren:n=!1},r)=>{if(r.depend({kind:`parent-edge`,parentId:e}),!t)return(n?await r.db.getAll(ie,[e]):await r.db.getAll(te,[e])).map(e=>e.id);let i=n?await r.db.getAll(_,[e]):await r.db.getAll(ne,[e]);return r.hydrateBlocks(G(i),{declareRowDeps:!1}).map(e=>e.id)}}),je=e({name:`core.byType`,argsSchema:a({workspaceId:s(),type:s()}),resultSchema:K,resolve:async({workspaceId:e,type:t},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:fe,key:k(e,t)});let r=await n.db.getAll(A,[e,t]);return n.hydrateBlocks(G(r))}}),q=a({workspaceId:s(),types:n(s()).optional(),where:o(s(),c()).optional(),referencedBy:u.optional(),match:n(l).optional(),exclude:n(l).optional(),order:t([`created-asc`,`created-desc`]).optional()}),Me=e=>`
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
`,J=(e,t,n)=>{if(e!==void 0)for(let[r,i]of Object.entries(e)){if(n.depend({kind:`plugin`,channel:le,key:pe(t,r)}),typeof i!=`object`||!i||i instanceof Date||Array.isArray(i))continue;let e=Object.entries(i);if(e.length!==1)continue;let[a,o]=e[0];if(a!==`target`||typeof o!=`object`||!o||Array.isArray(o))continue;let s=o;Object.values(s).some(b)||n.depend({kind:`plugin`,channel:ce,key:D(t)}),J(s,t,n)}},Ne=(e,t,n,r={})=>{if(e.sourceField!==void 0){n.depend({kind:`plugin`,channel:de,key:me(t,e.id,e.sourceField)});return}n.depend({kind:`plugin`,channel:ue,key:he(t,e.id)}),r.includeImplicitAncestorStructure&&n.depend({kind:`plugin`,channel:w,key:O(t,e.id)})},Pe=(e,t,n)=>{for(let r of e)J(r.where,t,n),r.referencedBy!==void 0&&Ne(r.referencedBy,t,n,{includeImplicitAncestorStructure:r.scope===`ancestor`})},Y=(e,t)=>{let n=e.workspaceId,r=e.types??[],i=e.referencedBy,a=e.match??[],o=e.exclude??[];for(let e of r)t.depend({kind:`plugin`,channel:fe,key:k(n,e)});J(e.where,n,t),i!==void 0&&Ne(i,n,t),Pe(a,n,t),Pe(o,n,t);let s=Object.values(e.where??{}).some(b),c=a.some(e=>e.referencedBy!==void 0||e.where!==void 0&&Object.values(e.where).some(b));return r.length>0||i!==void 0||s||c||t.depend({kind:`plugin`,channel:ce,key:D(n)}),{workspaceId:n,types:r,referencedBy:i,matchPredicates:a,excludePredicates:o}},X=(e,t)=>e.some(e=>e.scope===`ancestor`)||t.some(e=>e.scope===`ancestor`),Z=async(e,t,n)=>{oe(e);let r=se(e,t.repo.propertySchemas),i=await t.db.getAll(Me(r.sql),r.params);for(let r of i)n===`row`?t.depend({kind:`row`,id:r.anc_id}):t.depend({kind:`plugin`,channel:w,key:O(e.workspaceId,r.anc_id)})},Fe=async(e,t)=>{if(!e.workspaceId)return[];let n=x(e),{workspaceId:r,types:i,referencedBy:a,matchPredicates:o,excludePredicates:s}=Y(n,t);if(X(o,s)&&await Z(n,t,`row`),i.length===1&&n.where===void 0&&a===void 0&&o.length===0&&s.length===0&&n.order!==`created-desc`){let e=await t.db.getAll(A,[r,i[0]]);return t.hydrateBlocks(G(e))}let c=y(n,t.repo.propertySchemas),l=await t.db.getAll(c.sql,[...c.params]);return t.hydrateBlocks(G(l))},Ie=async(e,t)=>{if(!e.workspaceId)return[];let n=x(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=y(n,t.repo.propertySchemas,{projection:`ids`});return(await t.db.getAll(a.sql,[...a.params])).map(e=>e.id)},Le=e({name:`core.typedBlocks`,argsSchema:q,resultSchema:K,resolve:(e,t)=>Fe(e,t)}),Re=e({name:`core.typedBlockIds`,argsSchema:q,resultSchema:Ce,resolve:(e,t)=>Ie(e,t)}),ze=async(e,t)=>{if(!e.workspaceId)return 0;let n=x(e),{matchPredicates:r,excludePredicates:i}=Y(n,t);X(r,i)&&await Z(n,t,`structure`);let a=y(n,t.repo.propertySchemas,{projection:`count`});return(await t.db.get(a.sql,[...a.params]))?.count??0},Be=e({name:`core.typedBlockCount`,argsSchema:q,resultSchema:we,resolve:(e,t)=>ze(e,t)}),Ve=e({name:`core.searchByContent`,argsSchema:a({workspaceId:s(),query:s(),limit:i().optional()}),resultSchema:K,resolve:async({workspaceId:e,query:t,limit:n=50},r)=>{let i=F(t);if(i===null)return[];r.depend({kind:`plugin`,channel:C,key:E(e)});let a=await r.db.getAll(L,[e,i.matchQuery,i.rankQuery,I(i.rankQuery),n]);return r.hydrateBlocks(G(a),{declareRowDeps:!1})}}),He=async(e,t)=>(await e.db.getAll(z,[t,m])).flatMap(e=>f(e.id)),Q=e({name:`core.recentBlocks`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:K,resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:C,key:E(e)});let r=await n.db.getAll(R,[e,t]);return n.hydrateBlocks(G(r),{declareRowDeps:!1})}}),Ue=e({name:`core.recentActivity`,argsSchema:a({workspaceId:s(),limit:i().optional()}),resultSchema:{parse:e=>e},resolve:async({workspaceId:e,limit:t=50},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:C,key:E(e)});let r=await n.db.getAll(B,V(await He(n,e),e,t)),i=n.hydrateBlocks(G(r),{declareRowDeps:!1});if(i.length===0)return[];let a=await n.db.getAll(v(i.length),i.map(e=>e.id)),o=new Map;for(let e of i)o.set(e.id,[]);for(let e of a)o.get(e.chain_start_id)?.push(e);return i.map(t=>{let r=n.hydrateBlocks(G(o.get(t.id)??[]),{declareRowDeps:!1});for(let i of[t,...r])n.depend({kind:`plugin`,channel:w,key:O(e,i.id)});return{block:t,ancestors:r}})}}),We=e({name:`core.firstChildByContent`,argsSchema:a({parentId:s(),content:s()}),resultSchema:Te,resolve:async({parentId:e,content:t},n)=>{n.depend({kind:`parent-edge`,parentId:e});let r=await n.db.getAll(te,[e]);for(let e of r)n.depend({kind:`row`,id:e.id});let i=await n.db.getOptional(Se,[e,t]);return i===null?null:n.hydrateBlocks(G([i]),{declareRowDeps:!1})[0]??null}}),Ge=e({name:`core.aliasesInWorkspace`,argsSchema:a({workspaceId:s(),filter:s().optional()}),resultSchema:n(s()),resolve:async({workspaceId:e,filter:t=``},n)=>{if(!e)return[];n.depend({kind:`plugin`,channel:S,key:T(e)});let r=I(t);return(await n.db.getAll(H,[e,t,r,t,r])).map(e=>e.alias)}}),Ke=e({name:`core.aliasMatches`,argsSchema:a({workspaceId:s(),filter:s(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s()})),resolve:async({workspaceId:e,filter:t,limit:n=50},r)=>{if(!e)return[];r.depend({kind:`plugin`,channel:S,key:T(e)});let i=I(t),a=await r.db.getAll(xe,[e,t,i,t,i,n]);for(let e of a)r.depend({kind:`row`,id:e.blockId});return a}}),qe=e({name:`core.aliasMatchesFuzzy`,argsSchema:a({workspaceId:s(),prefixes:n(s()),query:s().optional(),limit:i().optional()}),resultSchema:n(a({alias:s(),blockId:s(),content:s(),updatedAt:i()})),resolve:async({workspaceId:e,prefixes:t,query:n=``,limit:r=100},i)=>{if(!e)return[];i.depend({kind:`plugin`,channel:S,key:T(e)});let a=W(t.length),o=n.toLowerCase(),s=[e,...t.map(I),o,I(o),r],c=await i.db.getAll(a,s);for(let e of c)i.depend({kind:`row`,id:e.blockId});return c}}),Je=e({name:`core.blockTypesByIds`,argsSchema:a({workspaceId:s(),blockIds:n(s()).max(200)}),resultSchema:n(a({blockId:s(),type:s()})),resolve:async({workspaceId:e,blockIds:t},n)=>{if(!e||t.length===0)return[];for(let e of t)n.depend({kind:`row`,id:e});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${r})
         AND json_type(b.properties_json, '$.types') = 'array'
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,[e,...t])}}),Ye=e({name:`core.aliasClaimantCounts`,argsSchema:a({workspaceId:s(),aliases:n(s()).max(200)}),resultSchema:n(a({alias:s(),claimants:i()})),resolve:async({workspaceId:e,aliases:t},n)=>{if(!e||t.length===0)return[];n.depend({kind:`plugin`,channel:S,key:T(e)});let r=t.map(()=>`?`).join(`, `);return n.db.getAll(`SELECT ba.alias AS alias, count(*) AS claimants
       FROM block_aliases ba
       JOIN blocks b ON b.id = ba.block_id
       WHERE ba.workspace_id = ?
         AND ba.alias IN (${r})
         AND b.deleted = 0
       GROUP BY ba.alias`,[e,...t])}}),Xe=e({name:`core.aliasLookup`,argsSchema:a({workspaceId:s(),alias:s()}),resultSchema:Te,resolve:async({workspaceId:e,alias:t},n)=>{if(!e||!t)return null;n.depend({kind:`plugin`,channel:S,key:T(e)});let r=await n.db.getOptional(U,[e,t]);return r===null?null:n.hydrateBlocks(G([r]))[0]??null}}),$=e({name:`core.findExtensionBlocks`,argsSchema:a({workspaceId:s()}),resultSchema:K,resolve:async({workspaceId:e},t)=>{if(!e)return[];let n=await t.db.getAll(A,[e,`extension`]);return t.hydrateBlocks(G(n))}}),Ze=[Ee,De,Oe,ke,Ae,je,Le,Re,Be,Ve,Q,Ue,We,Ge,Ke,qe,Je,Ye,Xe,$];export{Ze as KERNEL_QUERIES,H as SELECT_ALIASES_IN_WORKSPACE_SQL,xe as SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,ye as SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL,L as SELECT_BLOCKS_BY_CONTENT_SQL,A as SELECT_BLOCKS_BY_TYPE_SQL,be as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,U as SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,ge as SELECT_BLOCK_BY_ID_SQL,Se as SELECT_FIRST_CHILD_BY_CONTENT_SQL,R as SELECT_RECENT_BLOCKS_SQL,B as SELECT_RECENT_USER_BLOCKS_SQL,z as SELECT_USER_PAGE_IDS_SQL,Ye as aliasClaimantCountsQuery,Xe as aliasLookupQuery,qe as aliasMatchesFuzzyQuery,Ke as aliasMatchesQuery,Ge as aliasesInWorkspaceQuery,De as ancestorsQuery,Je as blockTypesByIdsQuery,W as buildFuzzyAliasMatchesSql,je as byTypeQuery,Ae as childIdsQuery,ke as childrenQuery,F as compileBlocksContentSearchQuery,$ as findExtensionBlocksQuery,We as firstChildByContentQuery,Oe as manyAncestorsQuery,Ue as recentActivityQuery,Q as recentBlocksQuery,V as recentUserBlocksParams,ze as resolveTypedBlockCount,Ie as resolveTypedBlockIds,Fe as resolveTypedBlocks,Ve as searchByContentQuery,Ee as subtreeQuery,Be as typedBlockCountQuery,Re as typedBlockIdsQuery,Le as typedBlocksQuery};
//# sourceMappingURL=kernelQueries.js.map