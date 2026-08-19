var e=(e,t,n)=>e===`defer`?{kind:`defer`}:n.hasPendingUpload||n.localUpdatedAt!==null&&n.localUpdatedAt===t&&n.localUpdatedAt!==0?{kind:`skip-stale`}:{kind:`apply`,decrypt:e===`decrypt`},t=`
  SELECT 1 AS one
    FROM (SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?) c
    LEFT JOIN blocks_synced s ON s.id = c.id
    LEFT JOIN blocks b ON b.id = c.id
   WHERE c.op = 'delete'
      OR s.id IS NULL
      OR b.id IS NULL
      OR b.updated_at = 0
      OR b.updated_at <> s.updated_at
   LIMIT 1`,n=`SELECT 1 AS one FROM blocks_synced_changes LIMIT 1 OFFSET ?`,r=1e4;export{n as STAGED_DEEPER_THAN_SCAN_SQL,t as STAGED_GAP_WITHIN_SCAN_SQL,r as STAGED_SCAN_LIMIT,e as decideStagingRow};
//# sourceMappingURL=reconcile.js.map