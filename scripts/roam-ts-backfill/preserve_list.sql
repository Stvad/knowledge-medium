WITH tx_size AS (
  SELECT tx_id, COUNT(DISTINCT block_id) bc FROM row_events WHERE tx_id IS NOT NULL GROUP BY tx_id
),
all_blocks AS (
  SELECT id FROM blocks
  WHERE workspace_id='ef43b424-80ba-4967-b587-a4c32efd8071' AND deleted=0
),
written AS (
  -- updated_at always advances on a synced edit, so an equal-stamp block can
  -- only have been touched locally → the sync paths can keep this bound (fast
  -- json_each); the local path scans all_blocks to catch pre-clamp
  -- skipMetadata writes that froze updated_at at created_at.
  SELECT id FROM blocks
  WHERE workspace_id='ef43b424-80ba-4967-b587-a4c32efd8071' AND deleted=0 AND created_at < updated_at
),
local_pres AS (
  -- genuine user edit: a SMALL tx (bulk ops are machine regardless of label —
  -- import, retagBlocks, repair, bulk migrations) AND a block-default scope AND
  -- a description that isn't a per-block machine op (migration / agent / sync).
  SELECT DISTINCT re.block_id
  FROM row_events re
  JOIN command_events ce ON ce.tx_id = re.tx_id
  JOIN tx_size ts ON ts.tx_id = re.tx_id AND ts.bc < 1000
  JOIN all_blocks t ON t.id = re.block_id
  WHERE re.kind = 'update'
    AND ce.scope = 'block-default'
    AND ce.description IS NOT NULL
    AND ce.description NOT LIKE 'roam import%'
    AND ce.description NOT LIKE 'migrate %'
    AND ce.description NOT LIKE 'processor:%'
    AND ce.description NOT LIKE '%readwise:%'
    AND ce.description NOT LIKE 'matrix message ingest%'
    AND ce.description NOT LIKE 'imported-from-roam%'
    AND ce.description NOT LIKE 'agent runtime%'
    AND ce.description NOT LIKE 'promote roam page%'
    AND ce.description NOT LIKE 'setBlockTypes%'
    AND ce.description NOT LIKE 'set property roam:%'
    AND ce.description NOT LIKE 'set property system:%'
),
sync_content AS (
  SELECT DISTINCT re.block_id
  FROM row_events re JOIN written t ON t.id = re.block_id
  WHERE re.source = 'sync' AND re.kind = 'update'
    AND json_extract(re.before_json,'$.content') IS NOT json_extract(re.after_json,'$.content')
    AND length(coalesce(json_extract(re.after_json,'$.content'),'')) > 0
),
sync_prop AS (
  -- types/alias are KEPT here (cross-device tagging is as real as local
  -- tagging; the local path already preserves it) — over-preserves a little
  -- derivation churn, the safe direction.
  SELECT DISTINCT re.block_id
  FROM row_events re JOIN written t ON t.id = re.block_id, json_each(re.after_json,'$.properties') ka
  WHERE re.source = 'sync' AND re.kind = 'update'
    AND ka.value IS NOT (SELECT kb.value FROM json_each(re.before_json,'$.properties') kb WHERE kb.key = ka.key)
    AND ka.key NOT LIKE 'roam:%' AND ka.key NOT LIKE 'readwise:%'
    AND ka.key NOT LIKE 'system:%' AND ka.key NOT LIKE 'place:%'
    AND ka.key NOT LIKE 'daily-note:%' AND ka.key NOT LIKE 'matrix-event:%'
    AND ka.key NOT IN ('editorSelection','focusedBlockLocation','scrollTop',
      'focusedBlockId','activePanelId','isEditing','previousLoadTime','currentLoadTime',
      'topLevelBlockId','editorFocusRequest','blockSelectionState','focusedVisualTargetKey',
      'recentBlockIds','lastOpenedAt')
)
SELECT block_id FROM local_pres
UNION SELECT block_id FROM sync_content
UNION SELECT block_id FROM sync_prop
