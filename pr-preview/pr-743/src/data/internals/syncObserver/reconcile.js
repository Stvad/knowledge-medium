var e=(e,t)=>e!==null&&e!==0&&e===t,t=(t,n,r)=>t===`defer`?{kind:`defer`}:r.hasPendingUpload||e(r.localUpdatedAt,n)?{kind:`skip-stale`}:{kind:`apply`,decrypt:t===`decrypt`},n=`
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
  ) LIMIT 1`,r=1e4,i=`
  SELECT COUNT(*) AS behind FROM (
    SELECT 1 FROM blocks_synced s
     WHERE s.workspace_id = ? AND s.needs_apply = 1
       AND NOT EXISTS (SELECT 1 FROM blocks_synced_changes c WHERE c.id = s.id)
     LIMIT ?
  )`,a=1e3,o=`
  UPDATE blocks_synced SET needs_apply = 0
   WHERE needs_apply = 1
     AND (
           EXISTS (
             SELECT 1 FROM blocks b
              WHERE b.id = blocks_synced.id
                AND b.updated_at <> 0
                AND b.updated_at = blocks_synced.updated_at
           )
           OR (
             blocks_synced.deleted = 1
             AND COALESCE(
                   (SELECT b.deleted FROM blocks b WHERE b.id = blocks_synced.id), 1
                 ) = 1
           )
         )
`;export{o as SEED_STAGING_NEEDS_APPLY_SQL,r as STAGED_SCAN_LIMIT,n as STAGED_VIEW_GAP_SQL,a as WORKSPACE_UNAPPLIED_COUNT_CAP,i as WORKSPACE_UNAPPLIED_SQL,t as decideStagingRow,e as localHoldsStagedVersion};
//# sourceMappingURL=reconcile.js.map