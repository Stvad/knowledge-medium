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
    SELECT 1 FROM blocks_synced s
      LEFT JOIN blocks b ON b.id = s.id
     WHERE s.workspace_id = ?
       AND (
              (b.id IS NULL AND s.deleted = 0)
           OR (b.id IS NOT NULL AND (b.updated_at = 0 OR s.updated_at > b.updated_at))
           )
     LIMIT ?
  )`,i=1e3;export{n as STAGED_SCAN_LIMIT,t as STAGED_VIEW_GAP_SQL,i as WORKSPACE_MATERIALIZATION_GAP_COUNT_CAP,r as WORKSPACE_MATERIALIZATION_GAP_SQL,e as decideStagingRow};
//# sourceMappingURL=reconcile.js.map