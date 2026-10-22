import { useRef, useEffect, type RefObject } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { flyAim, formatGodotVector3, type FlyPinnedPoint } from '../utils/flyAim'

interface FlyPinProps {
  pinLabelRef: RefObject<HTMLDivElement | null>
}

export function FlyPin({ pinLabelRef }: FlyPinProps) {
  const { camera, size } = useThree()
  const markerRef = useRef<THREE.Mesh>(null)
  const lastPinnedRef = useRef<FlyPinnedPoint | null>(null)
  const projVecRef = useRef(new THREE.Vector3())
  const camDirRef = useRef(new THREE.Vector3())
  const pointDirRef = useRef(new THREE.Vector3())

  useEffect(() => {
    return () => {
      if (pinLabelRef.current) {
        pinLabelRef.current.style.display = 'none'
      }
    }
  }, [pinLabelRef])

  useFrame(() => {
    const pinned = flyAim.pinnedPoint
    const marker = markerRef.current
    const label = pinLabelRef.current

    if (!pinned) {
      if (marker && marker.visible) {
        marker.visible = false
      }
      if (label && label.style.display !== 'none') {
        label.style.display = 'none'
      }
      lastPinnedRef.current = null
      return
    }

    if (marker) {
      marker.visible = true
      marker.position.copy(pinned.point)

      const perspCam = camera as THREE.PerspectiveCamera
      const dist = camera.position.distanceTo(pinned.point)
      const fovRad = (perspCam.fov * Math.PI) / 360
      const radius = (8 * dist * Math.tan(fovRad)) / Math.max(1, size.height)
      marker.scale.set(radius, radius, radius)
    }

    if (label) {
      if (lastPinnedRef.current !== pinned) {
        lastPinnedRef.current = pinned
        const posText = formatGodotVector3(pinned.point)
        const normText = formatGodotVector3(pinned.normal)
        label.innerText = `${posText}\nObject: ${pinned.objectName}\nNormal: ${normText}`
      }

      // Check if point is in front of camera
      camera.getWorldDirection(camDirRef.current)
      pointDirRef.current.subVectors(pinned.point, camera.position)

      if (camDirRef.current.dot(pointDirRef.current) <= 0) {
        label.style.display = 'none'
      } else {
        const proj = projVecRef.current.copy(pinned.point).project(camera)
        if (proj.z > 1 || proj.z < -1) {
          label.style.display = 'none'
        } else {
          const screenX = (proj.x * 0.5 + 0.5) * size.width
          const screenY = (-(proj.y * 0.5) + 0.5) * size.height
          label.style.display = 'block'
          label.style.transform = `translate(${Math.round(screenX + 12)}px, ${Math.round(screenY - 12)}px)`
        }
      }
    }
  })

  return (
    <mesh ref={markerRef} visible={false} renderOrder={999} raycast={() => {}}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial
        color="#ffcc00"
        depthTest={false}
        depthWrite={false}
        transparent
        opacity={0.95}
      />
    </mesh>
  )
}
