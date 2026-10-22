import { useEffect } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { useEditorStore, gizmoInteraction } from '../store/useEditorStore'
import { flyState } from '../utils/flyState'

export function ModelRenderer() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const selectSingle = useEditorStore((state) => state.selectSingle)
  const toggleSelection = useEditorStore((state) => state.toggleSelection)
  const showBones = useEditorStore((state) => state.showBones)
  const boneXray = useEditorStore((state) => state.boneXray)

  useEffect(() => {
    if (sceneRoot) {
      sceneRoot.traverse((node) => {
        if ('isMesh' in node && node.isMesh) {
          node.castShadow = true
          node.receiveShadow = true
          const mesh = node as import('three').Mesh
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          materials.forEach((mat) => {
            if (mat) {
              mat.depthWrite = true
              if (mat.transparent && mat.opacity === 1) {
                mat.alphaTest = mat.alphaTest > 0 ? mat.alphaTest : 0.05
              }
            }
          })
        }
      })
    }
  }, [sceneRoot])

  if (!sceneRoot) {
    return null
  }

  return (
    <primitive
      object={sceneRoot}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        if (flyState.active || Date.now() - flyState.exitedAt < 150) {
          return
        }

        if (gizmoInteraction.isHovered || gizmoInteraction.isDragging) {
          return
        }

        if (event.delta > 3) {
          return
        }

        // Prioritize bone marker if bones are shown and raycast intersects a bone handle
        if (showBones) {
          const boneHit = event.intersections.find((i) => i.object.userData?.isBoneHandle)
          if (boneHit) {
            const boneUuids = boneHit.object.userData?.boneUuids as string[] | undefined
            const boneUuid =
              boneHit.instanceId !== undefined && boneUuids
                ? boneUuids[boneHit.instanceId]
                : boneHit.object.userData?.boneUuid

            if (boneUuid) {
              // If boneXray is on, bone marker always wins over mesh
              // If boneXray is off, check if bone intersection is in front of mesh
              const meshIntersection = event.intersections.find((i) => i.object === event.object)
              if (
                boneXray ||
                !meshIntersection ||
                boneHit.distance <= meshIntersection.distance
              ) {
                event.stopPropagation()
                if (event.nativeEvent.altKey || event.altKey) {
                  toggleSelection(boneUuid)
                } else {
                  selectSingle(boneUuid)
                }
                return
              }
            }
          }
        }

        event.stopPropagation()
        if (event.nativeEvent.altKey || event.altKey) {
          toggleSelection(event.object.uuid)
        } else {
          selectSingle(event.object.uuid)
        }
      }}
    />
  )
}
