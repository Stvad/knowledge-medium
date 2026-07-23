import{isRefCodec as e,isRefListCodec as t}from"../api/codecs.js";import"../api/index.js";import{buildQualifiedBlockColumnsSql as n}from"../blockSchema.js";var r=e=>`$."${e.replaceAll(`\\`,`\\\\`).replaceAll(`"`,`\\"`)}"`,i=e=>`'${r(e).replaceAll(`'`,`''`)}'`,a=new Set([...new Set([`eq`,`lt`,`lte`,`gt`,`gte`]),`between`,`exists`,`target`]),o={eq:`=`,lt:`<`,lte:`<=`,gt:`>`,gte:`>=`},s=e=>typeof e==`object`&&!!e&&!(e instanceof Date)&&!Array.isArray(e),c=(e,t)=>{if(t===null)return{kind:`unset`};if(!s(t))return{kind:`comparator`,op:`eq`,operand:t};let n=Object.entries(t).filter(([e])=>e!==void 0);if(n.length!==1)throw Error(`[queryBlocks] where.${e} operator object must have exactly one key; got ${n.length} (combine via separate match/exclude predicates instead)`);let[r,i]=n[0];if(!a.has(r))throw Error(`[queryBlocks] where.${e} unknown operator ${JSON.stringify(r)}; supported: ${[...a].join(`, `)}`);if(r===`exists`){if(typeof i!=`boolean`)throw Error(`[queryBlocks] where.${e}.exists must be a boolean; got ${typeof i}`);return i?{kind:`set`}:{kind:`unset`}}if(r===`between`){if(!Array.isArray(i)||i.length!==2)throw Error(`[queryBlocks] where.${e}.between must be a [lo, hi] tuple`);return{kind:`between`,lo:i[0],hi:i[1]}}if(r===`target`){if(!s(i))throw Error(`[queryBlocks] where.${e}.target must be a where-map object`);return{kind:`target`,inner:i}}return{kind:`comparator`,op:r,operand:i}},l=(e,t,n)=>{if(!t.codec.where)throw Error(`[queryBlocks] where.${e} is not where-queryable; codec type ${JSON.stringify(t.codec.type)} doesn't support comparison predicates (use referencedBy for refs, or add a dedicated query for collection/object filters)`);try{return t.codec.where.encode(n)}catch(n){throw Error(`[queryBlocks] where.${e} value is not a valid ${t.codec.type}: ${n.message}`,{cause:n})}},u=(n,r,a,o,s,c)=>{let l=e(a.codec),u=t(a.codec);if(!l&&!u)throw Error(`[queryBlocks] where.${n}.target is only valid on ref / refList properties; ${JSON.stringify(n)} has codec type ${JSON.stringify(a.codec.type)}`);let f=`d${c.n++}`,p=`json_extract(${o}, ${i(n)})`,m=Object.entries(r).sort(([e],[t])=>e.localeCompare(t)),h=[],g=[];for(let[e,t]of m){let n=d(e,t,s.get(e),`${f}.properties_json`,s,c);h.push(n.sql),g.push(...n.params)}let _=h.length===0?``:` AND ${h.join(` AND `)}`;return l?{sql:`EXISTS (SELECT 1 FROM blocks ${f} WHERE ${f}.id = ${p} AND ${f}.deleted = 0${_})`,params:g}:{sql:`EXISTS (SELECT 1 FROM json_each(${p}) AS je JOIN blocks ${f} ON ${f}.id = je.value WHERE ${f}.deleted = 0${_})`,params:g}},d=(e,t,n,r,a,s={n:0})=>{if(t===void 0)throw Error(`[queryBlocks] where.${e} is undefined; pass null to match unset values`);if(n===void 0)throw Error(`[queryBlocks] where.${e} has no registered PropertySchema`);let d=`json_extract(${r}, ${i(e)})`,f=c(e,t);if(f.kind===`unset`)return{sql:`${d} IS NULL`,params:[]};if(f.kind===`set`)return{sql:`${d} IS NOT NULL`,params:[]};if(f.kind===`target`)return u(e,f.inner,n,r,a,s);if(f.kind===`between`){let t=l(e,n,f.lo),r=l(e,n,f.hi);return{sql:`${d} BETWEEN ? AND ?`,params:[t,r]}}let p=l(e,n,f.operand);return{sql:`${d} ${o[f.op]} ?`,params:[p]}},f=(e,t)=>{let n=[`br.source_id = ${t}`,`br.target_id = ?`],r=[e.id];return e.sourceField!==void 0&&(n.push(`br.source_field = ?`),r.push(e.sourceField)),{sql:`EXISTS (SELECT 1 FROM block_references br WHERE ${n.join(` AND `)})`,params:r}},p=(e,t,n)=>{let r=[],i=[],a=`${t}.properties_json`;if(e.id!==void 0&&(r.push(`${t}.id = ?`),i.push(e.id)),e.where!==void 0)for(let[t,o]of Object.entries(e.where).sort(([e],[t])=>e.localeCompare(t))){let e=d(t,o,n.get(t),a,n);r.push(e.sql),i.push(...e.params)}if(e.referencedBy!==void 0){let n=f(e.referencedBy,`${t}.id`);r.push(n.sql),i.push(...n.params)}return{sql:r.length===0?`1`:r.join(` AND `),params:i}},m=(e,t)=>{if((e.scope??`self`)===`self`)return p(e,`b`,t);let n=[],r=[];if(e.id!==void 0&&(n.push(`anc.id = ?`),r.push(e.id)),e.where!==void 0)for(let[i,a]of Object.entries(e.where).sort(([e],[t])=>e.localeCompare(t))){let e=d(i,a,t.get(i),`anc.properties_json`,t);n.push(e.sql),r.push(...e.params)}if(e.referencedBy!==void 0){let t=f(e.referencedBy,`anc.id`);e.referencedBy.sourceField===void 0?(n.push(`(${t.sql} OR anc.id = ?)`),r.push(...t.params,e.referencedBy.id)):(n.push(t.sql),r.push(...t.params))}return{sql:`EXISTS (
      SELECT 1 FROM ancestor_chain ac
      JOIN blocks anc ON anc.id = ac.anc_id
      WHERE ac.block_id = b.id AND ${n.length===0?`1`:n.join(` AND `)}
    )`,params:r}},h=e=>e?e.filter(e=>{let t=e.where!==void 0&&Object.keys(e.where).length>0,n=e.referencedBy!==void 0,r=e.id!==void 0;return t||n||r}):[],g=e=>({workspaceId:e.workspaceId,types:e.types===void 0?void 0:Array.from(new Set(e.types.map(e=>e.trim()).filter(Boolean))).sort(),where:e.where,referencedBy:e.referencedBy,match:h(e.match),exclude:h(e.exclude),order:e.order}),_=e=>e.some(e=>e.scope===`ancestor`),v=e=>(e.scope??`self`)===`self`,y=e=>{if(e===null)return!1;if(typeof e!=`object`||e instanceof Date||Array.isArray(e))return!0;let t=Object.entries(e);if(t.length!==1)return!0;let[n,r]=t[0];return!(n===`exists`&&r===!1)},b=e=>e!==void 0&&Object.values(e).some(y),x=e=>e.id!==void 0||e.referencedBy!==void 0||b(e.where),S=e=>{let t=e.match??[],n=e.exclude??[];if(!(_(t)||_(n)))return;let r=e.types??[];if(!(e.referencedBy!==void 0||r.length>0||b(e.where)||t.some(e=>v(e)&&x(e))))throw Error(`[queryBlocks] ancestor-scoped predicates require at least one candidate filter (types, referencedBy, or a non-null self where / match predicate) to bound the recursive walk`)},C=(e,t)=>{let n=g(e),r=n.types??[],i=n.match??[],a=n.exclude??[],o=[],s=[],c;if(n.referencedBy===void 0?(c=`FROM blocks b`,s.push(`b.workspace_id = ?`,`b.deleted = 0`),o.push(n.workspaceId)):(c=`FROM block_references br
      JOIN blocks b ON b.id = br.source_id`,s.push(`br.workspace_id = ?`,`br.target_id = ?`,`b.deleted = 0`),o.push(n.workspaceId,n.referencedBy.id),n.referencedBy.sourceField!==void 0&&(s.push(`br.source_field = ?`),o.push(n.referencedBy.sourceField))),r.length>0&&(s.push(`
      EXISTS (
        SELECT 1
        FROM block_types bt
        WHERE bt.block_id = b.id
          AND bt.workspace_id = b.workspace_id
          AND bt.type IN (${r.map(()=>`?`).join(`, `)})
      )
    `.trim()),o.push(...r)),n.where!==void 0)for(let[e,r]of Object.entries(n.where).sort(([e],[t])=>e.localeCompare(t))){let n=d(e,r,t.get(e),`b.properties_json`,t);s.push(n.sql),o.push(...n.params)}for(let e of i){if(!v(e))continue;let n=p(e,`b`,t);s.push(n.sql),o.push(...n.params)}for(let e of a){if(!v(e))continue;let n=p(e,`b`,t);s.push(`(${n.sql}) IS NOT TRUE`),o.push(...n.params)}return{sql:`candidates AS (
      SELECT DISTINCT b.id
      ${c}
      WHERE ${s.join(`
        AND `)}
    )`,params:o}},w=`ancestor_chain(block_id, anc_id, anc_parent_id, depth, path) AS (
    SELECT c.id, seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
    FROM candidates c
    JOIN blocks seed ON seed.id = c.id
    WHERE seed.deleted = 0
    UNION ALL
    SELECT
      ancestor_chain.block_id,
      parent.id,
      parent.parent_id,
      ancestor_chain.depth + 1,
      ancestor_chain.path || '!' || hex(parent.id) || '/'
    FROM ancestor_chain
    JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
    WHERE parent.deleted = 0
      AND ancestor_chain.depth < 100
      AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
  )`,T=(e,t,r={})=>{let i=g(e),a=i.match??[],o=i.exclude??[],s=_(a)||_(o);S(i);let c=C(i,t),l=[...c.params],u=[];for(let e of a){if(v(e))continue;let n=m(e,t);u.push(n.sql),l.push(...n.params)}for(let e of o){if(v(e))continue;let n=m(e,t);u.push(`(${n.sql}) IS NOT TRUE`),l.push(...n.params)}let d=s?`WITH RECURSIVE ${c.sql}, ${w}`:`WITH ${c.sql}`,f=r.projection===`count`,p=f?`COUNT(*) AS count`:r.projection===`ids`?`b.id AS id`:n(`b`),h=f?``:i.order===`created-desc`?`ORDER BY b.created_at DESC, b.id`:`ORDER BY b.created_at ASC, b.id ASC`;return{sql:`
    ${d}
    SELECT ${p}
    FROM candidates c
    JOIN blocks b ON b.id = c.id
    ${u.length>0?`WHERE ${u.join(`
      AND `)}`:``}
    ${h}
  `,params:l}};export{S as assertAncestorWalkBounded,C as buildCandidatesCte,T as compileTypedBlockQuery,_ as hasAncestorScope,y as isSelectiveWhereValue,r as jsonPathForProperty,g as normalizeTypedBlockQuery};
//# sourceMappingURL=typedBlockQuery.js.map