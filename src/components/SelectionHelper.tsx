import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { useEditorStore } from '../store/useEditorStore'

export function SelectionHelper() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const { scene } = useThree()
  const helpersRef = useRef<THREE.BoxHelper[]>([])

  useEffect(() => {
    // Clear and dispose previous helpers
    for (const helper of helpersRef.current) {
      scene.remove(helper)
      helper.dispose()
    }
    helpersRef.current = []

    if (!sceneRoot || selectedUuids.length === 0) return

    for (const uuid of selectedUuids) {
      const target =
        sceneRoot.uuid === uuid
          ? sceneRoot
          : sceneRoot.getObjectByProperty('uuid', uuid)

      if (!target || (target as any).isBone || target.type === 'Bone') continue

      const helper = new THREE.BoxHelper(target, 0x00b4d8)
      helper.raycast = () => {}

      const mat = helper.material as THREE.LineBasicMaterial
      mat.depthTest = false
      mat.transparent = true
      mat.opacity = 0.85

      scene.add(helper)
      helpersRef.current.push(helper)
    }

    return () => {
      for (const helper of helpersRef.current) {
        scene.remove(helper)
        helper.dispose()
      }
      helpersRef.current = []
    }
  }, [sceneRoot, selectedUuids, scene, structureVersion])

  useFrame(() => {
    for (const helper of helpersRef.current) {
      helper.update()
    }
  })

  return null
}
