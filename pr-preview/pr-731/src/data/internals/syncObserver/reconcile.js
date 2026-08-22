var e=(e,t,n)=>e===`defer`?{kind:`defer`}:n.hasPendingUpload||n.localUpdatedAt!==null&&n.localUpdatedAt===t&&n.localUpdatedAt!==0?{kind:`skip-stale`}:{kind:`apply`,decrypt:e===`decrypt`},t=`
  SELECT why FROM (
    SELECT 'deep' AS why FROM (SELECT 1 FROM blocks_synced_changes LIMIT 1 OFFSET ?)
    UNION ALL
    SELECT 'draining' AS why
      FROM (SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?) c
      LEFT JOIN blocks_synced s ON s.id = c.id
      LEFT JOIN blocks b ON b.id = c.id
     WHERE c.op = 'delete'
        OR s.id IS NULL
        OR b.id IS NULL
        OR b.updated_at = 0
        OR b.updated_at <> s.updated_at
  ) LIMIT 1`,n=1e4,r=`
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced
     WHERE workspace_id = ? AND needs_apply = 1
     LIMIT ?
  )`,i=1e3,a=`
  UPDATE blocks_synced SET needs_apply = 0
   WHERE id IN (
     SELECT s.id FROM blocks_synced s
      WHERE s.needs_apply = 1
        AND (
              EXISTS (
                SELECT 1 FROM blocks b
                 WHERE b.id = s.id AND b.updated_at <> 0 AND b.updated_at = s.updated_at
              )
              OR (
                s.deleted = 1
                AND COALESCE((SELECT b.deleted FROM blocks b WHERE b.id = s.id), 1) = 1
              )
            )
      LIMIT ?
   )
`,o=500;export{o as SEED_STAGING_NEEDS_APPLY_CHUNK,a as SEED_STAGING_NEEDS_APPLY_SQL,n as STAGED_SCAN_LIMIT,t as STAGED_VIEW_GAP_SQL,i as WORKSPACE_UNAPPLIED_COUNT_CAP,r as WORKSPACE_UNAPPLIED_SQL,e as decideStagingRow};
//# sourceMappingURL=reconcile.js.map