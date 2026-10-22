import { useEffect, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEditorStore, gizmoInteraction, type TransformMode } from '../store/useEditorStore'
import { flyState } from '../utils/flyState'
import { ModelRenderer } from './ModelRenderer'
import { BoneOverlay } from './BoneOverlay'
import { TransformGizmo } from './TransformGizmo'
import { SelectionHelper } from './SelectionHelper'
import { FloorGrid } from './FloorGrid'
import { NavigationGizmo } from './NavigationGizmo'
import { CameraZoomController } from './CameraZoomController'
import { FlyController } from './FlyController'
import { FlyCrosshair } from './FlyCrosshair'
import { FlyOutline } from './FlyOutline'
import { FlyPin } from './FlyPin'

export function Viewport() {
  const selectSingle = useEditorStore((state) => state.selectSingle)
  const isFlying = useEditorStore((state) => state.isFlying)
  const transformMode = useEditorStore((state) => state.transformMode)
  const setTransformMode = useEditorStore((state) => state.setTransformMode)
  const pivotMode = useEditorStore((state) => state.pivotMode)
  const setPivotMode = useEditorStore((state) => state.setPivotMode)
  const gizmoSpace = useEditorStore((state) => state.gizmoSpace)
  const setGizmoSpace = useEditorStore((state) => state.setGizmoSpace)
  const hasBones = useEditorStore((state) => state.hasBones)
  const showBones = useEditorStore((state) => state.showBones)
  const setShowBones = useEditorStore((state) => state.setShowBones)
  const boneSize = useEditorStore((state) => state.boneSize)
  const setBoneSize = useEditorStore((state) => state.setBoneSize)
  const boneXray = useEditorStore((state) => state.boneXray)
  const setBoneXray = useEditorStore((state) => state.setBoneXray)

  const controlsRef = useRef<any>(null)
  const pinLabelRef = useRef<HTMLDivElement>(null)

  const modes: { mode: TransformMode; label: string; key: string }[] = [
    { mode: 'translate', label: 'Translate', key: 'W' },
    { mode: 'rotate', label: 'Rotate', key: 'E' },
    { mode: 'scale', label: 'Scale', key: 'R' },
  ]

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (flyState.active) return

      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return
      }

      if (e.key.toLowerCase() === 'b' && hasBones) {
        setShowBones(!showBones)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasBones, showBones, setShowBones])

  return (
    <div className="viewport-container">
      {/* Floating 3D Transform Toolbar */}
      <div className="viewport-toolbar">
        <div className="toolbar-group">
          {modes.map(({ mode, label, key }) => (
            <button
              key={mode}
              type="button"
              className={`viewport-tool-btn ${transformMode === mode ? 'active' : ''}`}
              onClick={() => setTransformMode(mode)}
              title={`${label} (${key})`}
            >
              <span>{label}</span>
              <span className="hotkey-badge">{key}</span>
            </button>
          ))}
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`viewport-tool-btn ${pivotMode === 'center' ? 'active' : ''}`}
            onClick={() => setPivotMode('center')}
            title="Pivot: Center of geometry"
          >
            Center
          </button>
          <button
            type="button"
            className={`viewport-tool-btn ${pivotMode === 'origin' ? 'active' : ''}`}
            onClick={() => setPivotMode('origin')}
            title="Pivot: Object origin point (0, 0, 0)"
          >
            Origin
          </button>
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`viewport-tool-btn ${gizmoSpace === 'world' ? 'active' : ''}`}
            onClick={() => setGizmoSpace('world')}
            title="Gizmo orientation: World / Global axes"
          >
            Global
          </button>
          <button
            type="button"
            className={`viewport-tool-btn ${gizmoSpace === 'local' ? 'active' : ''}`}
            onClick={() => setGizmoSpace('local')}
            title="Gizmo orientation: Local object axes"
          >
            Local
          </button>
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`viewport-tool-btn ${showBones && hasBones ? 'active' : ''}`}
            onClick={() => setShowBones(!showBones)}
            disabled={!hasBones}
            title={hasBones ? 'Toggle Bones (B)' : 'No skeleton in model'}
          >
            <span>Bones</span>
            <span className="hotkey-badge">B</span>
          </button>
          {hasBones && showBones && (
            <>
              <label className="toolbar-checkbox-label" title="Render bones in front of mesh (X-Ray)">
                <input
                  type="checkbox"
                  checked={boneXray}
                  onChange={(e) => setBoneXray(e.target.checked)}
                />
                <span>X-Ray</span>
              </label>
              <div className="bone-size-control" title="Bone Marker Size">
                <input
                  type="range"
                  min="0.4"
                  max="2.5"
                  step="0.1"
                  value={boneSize}
                  onChange={(e) => setBoneSize(parseFloat(e.target.value))}
                  className="bone-size-slider"
                />
              </div>
            </>
          )}
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`viewport-tool-btn ${isFlying ? 'active' : ''}`}
            onClick={() => {
              if (flyState.active) {
                ;(flyState as any).confirmExit?.()
              } else {
                ;(flyState as any).startFly?.()
              }
            }}
            title="Fly / Walk Navigation (Shift + `)"
          >
            <span>Fly</span>
            <span className="hotkey-badge">⇧`</span>
          </button>
        </div>
      </div>

      <Canvas
        camera={{ position: [5, 4, 6], fov: 45 }}
        onPointerMissed={(e) => {
          if (flyState.active || Date.now() - flyState.exitedAt < 150) {
            return
          }
          if (gizmoInteraction.isHovered || gizmoInteraction.isDragging) {
            return
          }
          if (!e.altKey) {
            selectSingle(null)
          }
        }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#141414']} />

        {/* Local Lights */}
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 10]} intensity={1.2} />
        <directionalLight position={[-10, 10, -10]} intensity={0.5} />
        <hemisphereLight groundColor="#141414" intensity={0.3} />

        {/* Blender-style Floor Grid with Axes & Origin Marker */}
        <FloorGrid />

        {/* 3D Model, Skeleton Bones, Selection Box, and Gizmo */}
        <ModelRenderer />
        <BoneOverlay />
        <SelectionHelper />
        <TransformGizmo />

        {/* Navigation & Orientation (OrbitControls handles Rotate and Pan without inertia) */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping={false}
          enableZoom={false}
          rotateSpeed={0.55}
          panSpeed={0.6}
          minDistance={0.05}
          maxDistance={500}
        />

        {/* Progressive Blender-style Wheel Zoom Controller */}
        <CameraZoomController controlsRef={controlsRef} minDistance={0.05} maxDistance={500} />

        {/* Blender-style Fly / Walk Navigation Controller */}
        <FlyController controlsRef={controlsRef} />

        {/* Fly mode blue outline for hovered mesh */}
        {isFlying && <FlyOutline />}

        {/* Fly mode pinned point marker */}
        {isFlying && <FlyPin pinLabelRef={pinLabelRef} />}
      </Canvas>

      {/* Fly mode center crosshair */}
      <FlyCrosshair />

      {/* Fly mode pinned point coordinates label */}
      <div ref={pinLabelRef} className="fly-pin-label" aria-hidden="true" />

      {/* Interactive Blender-style Navigation Gizmo */}
      <NavigationGizmo controlsRef={controlsRef} />
    </div>
  )
}
