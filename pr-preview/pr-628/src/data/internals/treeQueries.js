var e=`
  WITH RECURSIVE subtree AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT child.*,
           subtree.path || child.order_key || '!' || hex(child.id) || '/',
           subtree.depth + 1
      FROM subtree
      JOIN blocks AS child INDEXED BY idx_blocks_parent_order
        ON child.parent_id = subtree.id
     WHERE child.deleted = 0
       AND subtree.depth < 100
       AND INSTR(subtree.path, '!' || hex(child.id) || '/') = 0
  )
  SELECT * FROM subtree ORDER BY path
`,t=`
  WITH RECURSIVE chain AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT parent.*,
           chain.path || '!' || hex(parent.id) || '/',
           chain.depth + 1
      FROM chain
      JOIN blocks AS parent ON parent.id = chain.parent_id
     WHERE parent.deleted = 0
       AND chain.depth < 100
       AND INSTR(chain.path, '!' || hex(parent.id) || '/') = 0
  )
  SELECT * FROM chain WHERE id != ? ORDER BY depth ASC
`,n=e=>{if(e<=0)throw Error(`manyAncestorsSql: idCount must be >= 1`);return`
    WITH RECURSIVE chain AS (
      SELECT blocks.*,
             blocks.id AS chain_start_id,
             '!' || hex(blocks.id) || '/' AS path,
             0 AS depth
        FROM blocks
       WHERE blocks.id IN (${Array(e).fill(`?`).join(`, `)}) AND blocks.deleted = 0
      UNION ALL
      SELECT parent.*,
             chain.chain_start_id,
             chain.path || '!' || hex(parent.id) || '/',
             chain.depth + 1
        FROM chain
        JOIN blocks AS parent ON parent.id = chain.parent_id
       WHERE parent.deleted = 0
         AND chain.depth < 100
         AND INSTR(chain.path, '!' || hex(parent.id) || '/') = 0
    )
    SELECT * FROM chain
    WHERE chain.id != chain.chain_start_id
    ORDER BY chain.chain_start_id, chain.depth ASC
  `},r=`
  WITH RECURSIVE chain AS (
    SELECT id, parent_id,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ?
    UNION ALL
    SELECT b.id, b.parent_id,
           chain.path || '!' || hex(b.id) || '/',
           chain.depth + 1
      FROM blocks AS b
      JOIN chain ON chain.parent_id = b.id
     WHERE chain.depth < 100
       AND INSTR(chain.path, '!' || hex(b.id) || '/') = 0
  )
  SELECT 1 AS hit FROM chain WHERE id = ? LIMIT 1
`,i=e=>{if(e<=0)throw Error(`cycleScanSql: idCount must be >= 1`);return`
    WITH RECURSIVE chain(start_id, id, parent_id, depth) AS (
      SELECT id, id, parent_id, 0
        FROM blocks
       WHERE id IN (${Array(e).fill(`?`).join(`,`)})
      UNION ALL
      SELECT chain.start_id, b.id, b.parent_id, chain.depth + 1
        FROM chain
        JOIN blocks AS b ON b.id = chain.parent_id
       WHERE chain.depth < 100
    ),
    cyclic AS (
      SELECT DISTINCT start_id FROM chain WHERE depth > 0 AND id = start_id
    )
    SELECT DISTINCT chain.id AS start_id
      FROM chain
      JOIN cyclic ON cyclic.start_id = chain.start_id
  `},a=`
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`,o=`
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`,s=e=>`
     COALESCE(${e}.is_field_form, 0) = 1
     AND ${e}.parent_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM block_types bt
          WHERE bt.block_id = ${e}.reference_target_id
            AND bt.type = 'property-schema'
            AND bt.workspace_id = ${e}.workspace_id
       )
       OR EXISTS (
         SELECT 1 FROM json_each(?) seed
          WHERE seed.value = ${e}.reference_target_id
            AND ${e}.workspace_id = ?
       )
     )
`,c=`
   AND NOT (
${s(`blocks`)}
   )
`,l=`
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
${c}
   ORDER BY order_key, id
`,u=`
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
${c}
   ORDER BY order_key, id
`,d=`
  WITH RECURSIVE
  subtree AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT child.*,
           subtree.path || child.order_key || '!' || hex(child.id) || '/',
           subtree.depth + 1
      FROM subtree
      JOIN blocks AS child INDEXED BY idx_blocks_parent_order
        ON child.parent_id = subtree.id
     WHERE child.deleted = 0
       AND subtree.depth < 100
       AND INSTR(subtree.path, '!' || hex(child.id) || '/') = 0
       AND NOT (
${s(`child`)}
       )
  )
  SELECT * FROM subtree ORDER BY path
`;export{t as ANCESTORS_SQL,o as CHILDREN_IDS_SQL,a as CHILDREN_SQL,r as IS_DESCENDANT_OF_SQL,e as SUBTREE_SQL,u as VISIBLE_CHILDREN_IDS_SQL,l as VISIBLE_CHILDREN_SQL,d as VISIBLE_SUBTREE_SQL,i as cycleScanSql,n as manyAncestorsSql};
//# sourceMappingURL=treeQueries.js.map