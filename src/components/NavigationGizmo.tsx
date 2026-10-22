import { useEffect, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { flyState } from '../utils/flyState'

interface NavigationGizmoProps {
  controlsRef: RefObject<any>
}

interface AxisDef {
  id: string
  label: string
  dir: THREE.Vector3
  color: string
  isPositive: boolean
}

const AXES: AxisDef[] = [
  { id: '+x', label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff3b4b', isPositive: true },
  { id: '-x', label: '', dir: new THREE.Vector3(-1, 0, 0), color: '#d94040', isPositive: false },
  { id: '+y', label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#45b359', isPositive: true },
  { id: '-y', label: '', dir: new THREE.Vector3(0, -1, 0), color: '#389a49', isPositive: false },
  { id: '+z', label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#3884ff', isPositive: true },
  { id: '-z', label: '', dir: new THREE.Vector3(0, 0, -1), color: '#2d6ed6', isPositive: false },
]

export function NavigationGizmo({ controlsRef }: NavigationGizmoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDraggingRef = useRef(false)
  const lastMousePosRef = useRef({ x: 0, y: 0 })
  const totalDragDistanceRef = useRef(0)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  // Cache projected axes for hit testing
  const projectedAxesRef = useRef<
    Array<AxisDef & { screenX: number; screenY: number; depth: number }>
  >([])

  const snapToAxis = (axisId: string) => {
    if (flyState.active) return
    const controls = controlsRef.current
    if (!controls || !controls.object) return
    const camera = controls.object as THREE.PerspectiveCamera | THREE.OrthographicCamera
    const target: THREE.Vector3 = controls.target || new THREE.Vector3(0, 0, 0)

    const dist = camera.position.distanceTo(target) || 10

    switch (axisId) {
      case '+x':
        camera.position.copy(target).add(new THREE.Vector3(dist, 0, 0))
        camera.up.set(0, 1, 0)
        break
      case '-x':
        camera.position.copy(target).add(new THREE.Vector3(-dist, 0, 0))
        camera.up.set(0, 1, 0)
        break
      case '+y':
        camera.position.copy(target).add(new THREE.Vector3(0, dist, 0.0001))
        camera.up.set(0, 0, -1)
        break
      case '-y':
        camera.position.copy(target).add(new THREE.Vector3(0, -dist, 0.0001))
        camera.up.set(0, 0, 1)
        break
      case '+z':
        camera.position.copy(target).add(new THREE.Vector3(0, 0, dist))
        camera.up.set(0, 1, 0)
        break
      case '-z':
        camera.position.copy(target).add(new THREE.Vector3(0, 0, -dist))
        camera.up.set(0, 1, 0)
        break
    }

    camera.lookAt(target)
    controls.update()
  }

  // Draw loop
  useEffect(() => {
    let animId: number

    const render = () => {
      const canvas = canvasRef.current
      const controls = controlsRef.current
      if (!canvas || !controls || !controls.object) {
        animId = requestAnimationFrame(render)
        return
      }

      const camera = controls.object as THREE.Camera
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const displaySize = 104
      if (canvas.width !== displaySize * dpr || canvas.height !== displaySize * dpr) {
        canvas.width = displaySize * dpr
        canvas.height = displaySize * dpr
      }

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, displaySize, displaySize)

      const cx = displaySize / 2
      const cy = displaySize / 2
      const radius = 34

      // Draw background pod when hovered or dragging (Blender style)
      if (isHovered || isDraggingRef.current) {
        ctx.beginPath()
        ctx.arc(cx, cy, 48, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(28, 31, 36, 0.75)'
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
        ctx.stroke()
      }

      // Project world axes into camera space
      const viewMat3 = new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse)

      const projected = AXES.map((axis) => {
        const camDir = axis.dir.clone().applyMatrix3(viewMat3)
        return {
          ...axis,
          screenX: cx + camDir.x * radius,
          screenY: cy - camDir.y * radius,
          depth: -camDir.z, // higher means closer to camera
        }
      })

      // Sort by depth (farthest first)
      projected.sort((a, b) => a.depth - b.depth)
      projectedAxesRef.current = projected

      // Draw axis stems
      for (const item of projected) {
        if (item.isPositive) {
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.lineTo(item.screenX, item.screenY)
          ctx.strokeStyle = item.color
          ctx.lineWidth = 2.2
          ctx.stroke()
        }
      }

      // Draw axis caps
      for (const item of projected) {
        if (item.isPositive) {
          // Positive handle with letter
          ctx.beginPath()
          ctx.arc(item.screenX, item.screenY, 8.5, 0, Math.PI * 2)
          ctx.fillStyle = item.color
          ctx.fill()

          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 9px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(item.label, item.screenX, item.screenY)
        } else {
          // Negative axis handle (subtle dot)
          ctx.beginPath()
          ctx.arc(item.screenX, item.screenY, 4, 0, Math.PI * 2)
          ctx.fillStyle = item.color
          ctx.globalAlpha = 0.5
          ctx.fill()
          ctx.globalAlpha = 1.0
        }
      }

      ctx.restore()
      animId = requestAnimationFrame(render)
    }

    animId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animId)
  }, [isHovered, controlsRef])

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (flyState.active) return
    e.stopPropagation()
    e.preventDefault()

    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)

    isDraggingRef.current = true
    setIsDragging(true)
    lastMousePosRef.current = { x: e.clientX, y: e.clientY }
    totalDragDistanceRef.current = 0
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (flyState.active) return
    e.stopPropagation()

    if (!isDraggingRef.current) return

    const dx = e.clientX - lastMousePosRef.current.x
    const dy = e.clientY - lastMousePosRef.current.y
    totalDragDistanceRef.current += Math.hypot(dx, dy)
    lastMousePosRef.current = { x: e.clientX, y: e.clientY }

    const controls = controlsRef.current
    if (!controls || !controls.object) return
    const camera = controls.object as THREE.Camera
    const target: THREE.Vector3 = controls.target || new THREE.Vector3(0, 0, 0)

    // Spherical orbit around current controls.target
    const offset = camera.position.clone().sub(target)
    const spherical = new THREE.Spherical().setFromVector3(offset)

    const sensitivity = 0.012
    spherical.theta -= dx * sensitivity
    spherical.phi -= dy * sensitivity

    // Clamp phi to prevent upside-down flip
    const EPS = 0.0001
    spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, spherical.phi))

    offset.setFromSpherical(spherical)
    camera.position.copy(target).add(offset)
    camera.lookAt(target)
    controls.update()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (flyState.active) return
    e.stopPropagation()
    e.preventDefault()

    const target = e.currentTarget
    try {
      target.releasePointerCapture(e.pointerId)
    } catch {
      // Ignored if capture was already lost
    }

    const wasDrag = totalDragDistanceRef.current > 3
    isDraggingRef.current = false
    setIsDragging(false)

    // If not a drag, check if an axis cap was clicked
    if (!wasDrag) {
      const rect = target.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const clickY = e.clientY - rect.top

      // Check hits from closest to farthest
      const reversed = [...projectedAxesRef.current].reverse()
      for (const item of reversed) {
        const dist = Math.hypot(clickX - item.screenX, clickY - item.screenY)
        const hitRadius = item.isPositive ? 12 : 8
        if (dist <= hitRadius) {
          snapToAxis(item.id)
          break
        }
      }
    }
  }

  return (
    <div
      className="navigation-gizmo-container"
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
    >
      <canvas
        ref={canvasRef}
        className={`navigation-gizmo-canvas ${isDragging ? 'dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </div>
  )
}
