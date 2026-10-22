import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { flyState } from '../utils/flyState'

interface CameraZoomControllerProps {
  controlsRef: React.RefObject<any>
  minDistance?: number
  maxDistance?: number
}

export function CameraZoomController({
  controlsRef,
  minDistance = 0.05,
  maxDistance = 500,
}: CameraZoomControllerProps) {
  const { camera, gl } = useThree()
  const targetDistanceRef = useRef<number | null>(null)
  const isWheelingRef = useRef(false)
  const wheelTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    const domElement = gl.domElement

    const handleWheel = (e: WheelEvent) => {
      if (flyState.active) return

      e.preventDefault()
      e.stopPropagation()

      const controls = controlsRef.current
      if (!controls) return

      const target: THREE.Vector3 = controls.target || new THREE.Vector3(0, 0, 0)
      const currentDist = camera.position.distanceTo(target)

      if (targetDistanceRef.current === null) {
        targetDistanceRef.current = currentDist
      }

      // Normalize wheel delta across browsers and devices
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 30
      if (e.deltaMode === 2) dy *= 300

      // Clamp delta per event to prevent astronomical jumps
      const clampedSteps = Math.max(-4, Math.min(4, dy / 100))

      // Exponential base: 1.20 for progressive Blender-like zooming
      // dy > 0 (scroll down) -> zoom out -> factor > 1
      // dy < 0 (scroll up)   -> zoom in  -> factor < 1
      const factor = Math.pow(1.20, clampedSteps)

      let newTargetDist = targetDistanceRef.current * factor
      newTargetDist = Math.max(minDistance, Math.min(maxDistance, newTargetDist))
      targetDistanceRef.current = newTargetDist

      isWheelingRef.current = true
      if (wheelTimeoutRef.current) {
        clearTimeout(wheelTimeoutRef.current)
      }
      wheelTimeoutRef.current = window.setTimeout(() => {
        isWheelingRef.current = false
      }, 120)
    }

    domElement.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      domElement.removeEventListener('wheel', handleWheel)
      if (wheelTimeoutRef.current) {
        clearTimeout(wheelTimeoutRef.current)
      }
    }
  }, [gl, camera, minDistance, maxDistance, controlsRef])

  useFrame((_, delta) => {
    if (flyState.active) return

    const controls = controlsRef.current
    if (!controls) return
    const target: THREE.Vector3 = controls.target || new THREE.Vector3(0, 0, 0)

    const currentDist = camera.position.distanceTo(target)

    // Keep target distance synchronized with camera whenever not actively wheeling
    if (!isWheelingRef.current) {
      targetDistanceRef.current = currentDist
      return
    }

    if (targetDistanceRef.current === null) return

    const targetDist = targetDistanceRef.current
    if (Math.abs(currentDist - targetDist) > 0.0001) {
      // Rapid frame-rate independent exponential interpolation (~80ms decay)
      const decay = 20
      const alpha = 1 - Math.exp(-decay * delta)
      const nextDist = THREE.MathUtils.lerp(currentDist, targetDist, alpha)

      // Move camera along ray from target
      let dir = new THREE.Vector3().subVectors(camera.position, target)
      if (dir.lengthSq() < 0.00001) {
        dir = new THREE.Vector3(0, 0, 1)
      } else {
        dir.normalize()
      }

      camera.position.copy(target).addScaledVector(dir, nextDist)
      controls.update()
    }
  })

  return null
}
