import {
  blockRenderersFacet,
  actionsFacet,
  definitionSeedsFacet,
  ActionContextTypes,
  seedProperty,
  ChangeScope,
} from '@/extensions/api.js'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.js'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.js'
import {
  useState,
  useSyncExternalStore,
  useRef,
  useCallback,
  useMemo,
} from 'react'

// Canvas mode is a deliberately device-local layout preference (canvas on a
// wide desktop, plain layout on a phone), so it lives in localStorage rather
// than a synced prefs block.
// lint-ok: config-in-localstorage (device-local canvas toggle, must not sync)
const CANVAS_STORAGE_KEY = 'canvas-layout:enabled'

const readPersistedMode = () => {
  try {
    return localStorage.getItem(CANVAS_STORAGE_KEY) === 'true'
  } catch (e) {
    return false
  }
}
const writePersistedMode = (v) => {
  try {
    localStorage.setItem(CANVAS_STORAGE_KEY, v ? 'true' : 'false')
  } catch (e) {}
}

// Canvas-mode visibility — a typed module store backed by localStorage,
// NOT a window CustomEvent. The toggle/enable/disable actions and the
// exit button flip it; the renderer reads it with useSyncExternalStore
// (the same mechanism the app's own DialogHost uses).
let canvasMode = readPersistedMode()
const canvasListeners = new Set()
const setCanvasMode = (next) => {
  canvasMode = next
  writePersistedMode(next)
  canvasListeners.forEach((notify) => notify())
}
const toggleCanvasMode = () => setCanvasMode(!canvasMode)
const subscribeCanvasMode = (notify) => {
  canvasListeners.add(notify)
  return () => canvasListeners.delete(notify)
}
const isCanvasMode = () => canvasMode

// NOTE: the pre-conversion `defineProperty` calls here passed a `scope` key
// (the `repo.tx` options field name), not `changeScope` (the schema field) —
// so `changeScope` was actually left `undefined` on all four schemas. Read as
// intent, `ChangeScope.UiState` is what the author meant; seedProperty
// requires a valid ChangeScope so that's what's declared below.
const canvasXProp = seedProperty({
  seedKey: 'system:canvas-layout/property/x',
  revision: 1,
  name: 'canvasX',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.UiState,
})
const canvasYProp = seedProperty({
  seedKey: 'system:canvas-layout/property/y',
  revision: 1,
  name: 'canvasY',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.UiState,
})
const canvasWProp = seedProperty({
  seedKey: 'system:canvas-layout/property/w',
  revision: 1,
  name: 'canvasW',
  preset: 'number',
  defaultValue: 480,
  changeScope: ChangeScope.UiState,
})
const canvasHProp = seedProperty({
  seedKey: 'system:canvas-layout/property/h',
  revision: 1,
  name: 'canvasH',
  preset: 'number',
  defaultValue: 360,
  changeScope: ChangeScope.UiState,
})

const useBlockSnapshot = (block) => {
  return useSyncExternalStore(
    useCallback((cb) => block.subscribe(cb), [block]),
    useCallback(() => block.peek(), [block]),
    useCallback(() => block.peek(), [block]),
  )
}

const useHandlePeek = (handle) => {
  return useSyncExternalStore(
    useCallback((cb) => handle.subscribe(cb), [handle]),
    useCallback(() => handle.peek(), [handle]),
    useCallback(() => handle.peek(), [handle]),
  )
}

const readPanelGeometry = (panelBlock, indexFallback) => {
  const snap = panelBlock.peek()
  const props = snap?.properties ?? {}
  const cols = 3
  const col = indexFallback % cols
  const row = Math.floor(indexFallback / cols)
  const defaultX = 40 + col * 500
  const defaultY = 40 + row * 380
  const x = typeof props.canvasX === 'number' ? props.canvasX : defaultX
  const y = typeof props.canvasY === 'number' ? props.canvasY : defaultY
  const w = typeof props.canvasW === 'number' ? props.canvasW : 480
  const h = typeof props.canvasH === 'number' ? props.canvasH : 360
  return { x, y, w, h }
}

const CanvasPanelCard = ({ panelBlock, index, onBringToFront, zIndex }) => {
  // Re-render when this panel's snapshot changes (position updates)
  useBlockSnapshot(panelBlock)
  const geo = readPanelGeometry(panelBlock, index)
  const dragRef = useRef(null)
  const containerRef = useRef(null)

  const onPointerDown = useCallback(
    (e) => {
      onBringToFront?.(panelBlock.id)
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      const origin = readPanelGeometry(panelBlock, index)
      dragRef.current = { startX, startY, origin }
      e.preventDefault()
      e.stopPropagation()
      const move = (ev) => {
        const d = dragRef.current
        if (!d) return
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - d.startY
        if (containerRef.current) {
          containerRef.current.style.left = d.origin.x + dx + 'px'
          containerRef.current.style.top = d.origin.y + dy + 'px'
        }
      }
      const up = async (ev) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const d = dragRef.current
        dragRef.current = null
        if (!d) return
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - d.startY
        const nextX = d.origin.x + dx
        const nextY = d.origin.y + dy
        try {
          await panelBlock.set(canvasXProp, nextX)
          await panelBlock.set(canvasYProp, nextY)
        } catch (err) {
          console.error('[canvas-layout] failed to persist position', err)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panelBlock, index, onBringToFront],
  )

  const onResizePointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const origin = readPanelGeometry(panelBlock, index)
      const move = (ev) => {
        const dw = ev.clientX - startX
        const dh = ev.clientY - startY
        if (containerRef.current) {
          containerRef.current.style.width = Math.max(240, origin.w + dw) + 'px'
          containerRef.current.style.height = Math.max(160, origin.h + dh) + 'px'
        }
      }
      const up = async (ev) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const dw = ev.clientX - startX
        const dh = ev.clientY - startY
        try {
          await panelBlock.set(canvasWProp, Math.max(240, origin.w + dw))
          await panelBlock.set(canvasHProp, Math.max(160, origin.h + dh))
        } catch (err) {
          console.error('[canvas-layout] failed to persist size', err)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [panelBlock, index],
  )

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        left: geo.x,
        top: geo.y,
        width: geo.w,
        height: geo.h,
        background: 'var(--surface, #fff)',
        border: '1px solid var(--border, #d0d7de)',
        borderRadius: 8,
        boxShadow: '0 4px 18px rgba(0,0,0,0.12)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        style={{
          padding: '6px 10px',
          background: 'var(--surface-2, #f6f8fa)',
          borderBottom: '1px solid var(--border, #d0d7de)',
          cursor: 'grab',
          userSelect: 'none',
          fontSize: 12,
          fontWeight: 500,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>panel {panelBlock.id.slice(0, 6)}</span>
        <span style={{ opacity: 0.5, fontSize: 11 }}>
          {Math.round(geo.x)}, {Math.round(geo.y)}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        <PanelRenderer block={panelBlock} />
      </div>
      <div
        onPointerDown={onResizePointerDown}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 14,
          height: 14,
          cursor: 'nwse-resize',
          background:
            'linear-gradient(135deg, transparent 50%, var(--border, #d0d7de) 50%)',
        }}
      />
    </div>
  )
}

const CanvasView = ({ block }) => {
  const subtreeHandle = useMemo(
    () => block.repo.query.subtree({ id: block.id }),
    [block],
  )
  const rows = useHandlePeek(subtreeHandle) ?? []
  const panelRows = useMemo(
    () =>
      rows.filter((r) => {
        const types = r?.properties?.types
        return Array.isArray(types) && types.includes('panel')
      }),
    [rows],
  )
  const [zMap, setZMap] = useState({})
  const bringToFront = useCallback((id) => {
    setZMap((m) => {
      const max = Math.max(0, ...Object.values(m))
      return { ...m, [id]: max + 1 }
    })
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'auto',
        background:
          'repeating-linear-gradient(0deg, var(--border, #e5e7eb) 0 1px, transparent 1px 40px), repeating-linear-gradient(90deg, var(--border, #e5e7eb) 0 1px, transparent 1px 40px), var(--background, #fafbfc)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 6px 4px 10px',
          background: 'var(--surface-2, #f6f8fa)',
          border: '1px solid var(--border, #d0d7de)',
          borderRadius: 6,
          fontSize: 12,
          zIndex: 10000,
          userSelect: 'none',
        }}
      >
        <span>canvas layout — {panelRows.length} panel(s)</span>
        <button
          type="button"
          onClick={() => setCanvasMode(false)}
          title="Exit canvas layout"
          aria-label="Exit canvas layout"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            padding: 0,
            border: '1px solid var(--border, #d0d7de)',
            borderRadius: 4,
            background: 'var(--background, #fff)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            color: 'var(--foreground, #24292f)',
          }}
        >
          ×
        </button>
      </div>
      {panelRows.map((row, i) => {
        const panelBlock = block.repo.block(row.id)
        return (
          <CanvasPanelCard
            key={row.id}
            panelBlock={panelBlock}
            index={i}
            onBringToFront={bringToFront}
            zIndex={zMap[row.id] ?? i + 1}
          />
        )
      })}
    </div>
  )
}

const CanvasLayoutRenderer = ({ block }) => {
  const canvasMode = useSyncExternalStore(subscribeCanvasMode, isCanvasMode, isCanvasMode)

  if (!canvasMode) {
    return <LayoutRenderer block={block} />
  }
  return <CanvasView block={block} />
}

const toggleCanvasLayoutAction = {
  id: 'canvas-layout.toggle',
  description: 'Toggle canvas layout',
  context: ActionContextTypes.GLOBAL,
  handler: () => toggleCanvasMode(),
}

const enableCanvasLayoutAction = {
  id: 'canvas-layout.enable',
  description: 'Enable canvas layout',
  context: ActionContextTypes.GLOBAL,
  handler: () => setCanvasMode(true),
}

const disableCanvasLayoutAction = {
  id: 'canvas-layout.disable',
  description: 'Disable canvas layout',
  context: ActionContextTypes.GLOBAL,
  handler: () => setCanvasMode(false),
}

export default [
  definitionSeedsFacet.of(canvasXProp),
  definitionSeedsFacet.of(canvasYProp),
  definitionSeedsFacet.of(canvasWProp),
  definitionSeedsFacet.of(canvasHProp),
  blockRenderersFacet.of({
    id: 'layout',
    renderer: CanvasLayoutRenderer,
  }),
  actionsFacet.of(toggleCanvasLayoutAction),
  actionsFacet.of(enableCanvasLayoutAction),
  actionsFacet.of(disableCanvasLayoutAction),
]
