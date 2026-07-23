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
`,s=`
   AND (
     blocks.reference_target_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM workspaces w
        WHERE w.id = blocks.workspace_id
          AND w.properties_migration IN ('children', 'cell-off')
     )
     OR NOT EXISTS (
       SELECT 1 FROM block_types bt
        WHERE bt.block_id = blocks.reference_target_id
          AND bt.type = 'property-schema'
          AND bt.workspace_id = blocks.workspace_id
     )
     OR EXISTS (
       WITH RECURSIVE up(id, reference_target_id, parent_id, workspace_id, path, depth) AS (
         SELECT id, reference_target_id, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id = ?
         UNION ALL
         SELECT b.id, b.reference_target_id, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b
           JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT 1 FROM up
        WHERE up.reference_target_id IS NOT NULL
          -- §9 root half: a workspace-root row is never a field row, so it
          -- never makes its descendants "interior" (twin of the parentId
          -- check in isPropertyFieldInstance).
          AND up.parent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM block_types bt2
             WHERE bt2.block_id = up.reference_target_id
               AND bt2.type = 'property-schema'
               AND bt2.workspace_id = up.workspace_id
          )
        LIMIT 1
     )
   )
`,c=`
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
${s}
   ORDER BY order_key, id
`,l=`
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
${s}
   ORDER BY order_key, id
`,u=`
  WITH RECURSIVE
  root_exempt(v) AS (
    SELECT CASE WHEN EXISTS (
      WITH RECURSIVE up(id, reference_target_id, parent_id, workspace_id, path, depth) AS (
        SELECT id, reference_target_id, parent_id, workspace_id,
               '!' || hex(id) || '/',
               0
          FROM blocks WHERE id = ?
        UNION ALL
        SELECT b.id, b.reference_target_id, b.parent_id, b.workspace_id,
               up.path || '!' || hex(b.id) || '/',
               up.depth + 1
          FROM blocks AS b
          JOIN up ON b.id = up.parent_id
         WHERE up.depth < 100
           AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
      )
      SELECT 1 FROM up
       WHERE up.reference_target_id IS NOT NULL
         -- §9 root half: a workspace-root row is never a field row (twin
         -- of the parentId check in isPropertyFieldInstance).
         AND up.parent_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = up.workspace_id
              AND w.properties_migration IN ('children', 'cell-off')
         )
         AND EXISTS (
           SELECT 1 FROM block_types bt
            WHERE bt.block_id = up.reference_target_id
              AND bt.type = 'property-schema'
              AND bt.workspace_id = up.workspace_id
         )
       LIMIT 1
    ) THEN 1 ELSE 0 END
  ),
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
       AND (
         (SELECT v FROM root_exempt) = 1
         OR child.reference_target_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = child.workspace_id
              AND w.properties_migration IN ('children', 'cell-off')
         )
         OR NOT EXISTS (
           SELECT 1 FROM block_types bt
            WHERE bt.block_id = child.reference_target_id
              AND bt.type = 'property-schema'
              AND bt.workspace_id = child.workspace_id
         )
       )
  )
  SELECT * FROM subtree ORDER BY path
`;export{t as ANCESTORS_SQL,o as CHILDREN_IDS_SQL,a as CHILDREN_SQL,r as IS_DESCENDANT_OF_SQL,e as SUBTREE_SQL,l as VISIBLE_CHILDREN_IDS_SQL,c as VISIBLE_CHILDREN_SQL,u as VISIBLE_SUBTREE_SQL,i as cycleScanSql,n as manyAncestorsSql};
//# sourceMappingURL=treeQueries.js.map