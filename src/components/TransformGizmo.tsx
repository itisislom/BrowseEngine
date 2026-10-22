import { useEffect, useMemo, useRef, useCallback } from 'react'
import { TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import {
  useEditorStore,
  getObjectSnapshot,
  areSnapshotsEqual,
  gizmoInteraction,
  type TransformSnapshot,
  type PropertyChange,
} from '../store/useEditorStore'
import { flyState } from '../utils/flyState'
import { getNodeId } from '../utils/nodeRegistry'

function filterAncestors(objects: THREE.Object3D[]): THREE.Object3D[] {
  return objects.filter((obj) => {
    let curr = obj.parent
    while (curr) {
      if (objects.includes(curr)) {
        return false
      }
      curr = curr.parent
    }
    return true
  })
}

interface DragItem {
  obj: THREE.Object3D
  before: TransformSnapshot
  startMatrixWorld: THREE.Matrix4
}

export function TransformGizmo() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const transformMode = useEditorStore((state) => state.transformMode)
  const pivotMode = useEditorStore((state) => state.pivotMode)
  const gizmoSpace = useEditorStore((state) => state.gizmoSpace)
  const setTransformMode = useEditorStore((state) => state.setTransformMode)
  const bumpTransformVersion = useEditorStore((state) => state.bumpTransformVersion)
  const pushHistory = useEditorStore((state) => state.pushHistory)
  const transformVersion = useEditorStore((state) => state.transformVersion)
  const isFlying = useEditorStore((state) => state.isFlying)
  const setIsGizmoHovered = useEditorStore((state) => state.setIsGizmoHovered)
  const setIsGizmoDragging = useEditorStore((state) => state.setIsGizmoDragging)

  const controlsRef = useRef<any>(null)
  const dragItemsRef = useRef<DragItem[]>([])
  const proxyStartInvRef = useRef<THREE.Matrix4 | null>(null)

  const proxyObject = useMemo(() => new THREE.Object3D(), [])

  // Find all selected objects and filter out descendants of other selected objects
  const effectiveObjects = useMemo(() => {
    if (!sceneRoot || selectedUuids.length === 0) return []

    const objects: THREE.Object3D[] = []
    for (const uuid of selectedUuids) {
      const found =
        sceneRoot.uuid === uuid
          ? sceneRoot
          : sceneRoot.getObjectByProperty('uuid', uuid)
      if (found && !(found as any).isSkinnedMesh) {
        objects.push(found)
      }
    }

    return filterAncestors(objects)
  }, [sceneRoot, selectedUuids])

  const syncProxyToPivot = useCallback(() => {
    if (effectiveObjects.length === 0) return

    const center = new THREE.Vector3()

    if (effectiveObjects.length === 1) {
      const single = effectiveObjects[0]
      const isBone = (single as any).isBone || single.type === 'Bone'

      if (isBone) {
        // Pivot for a bone is strictly at its head (world position)
        single.getWorldPosition(center)
      } else if (pivotMode === 'center') {
        const box = new THREE.Box3().setFromObject(single)
        if (!box.isEmpty()) {
          box.getCenter(center)
        } else {
          single.getWorldPosition(center)
        }
      } else {
        single.getWorldPosition(center)
      }

      if (gizmoSpace === 'local') {
        const worldQuat = new THREE.Quaternion()
        single.getWorldQuaternion(worldQuat)
        proxyObject.quaternion.copy(worldQuat)
      } else {
        proxyObject.quaternion.set(0, 0, 0, 1)
        proxyObject.rotation.set(0, 0, 0)
      }
    } else {
      // Multiple objects
      if (pivotMode === 'center') {
        const box = new THREE.Box3()
        const tempPos = new THREE.Vector3()

        for (const obj of effectiveObjects) {
          if ((obj as any).isBone || obj.type === 'Bone') {
            obj.getWorldPosition(tempPos)
            box.expandByPoint(tempPos)
          } else {
            box.expandByObject(obj)
          }
        }

        if (!box.isEmpty()) {
          box.getCenter(center)
        } else {
          effectiveObjects[0].getWorldPosition(center)
        }
      } else {
        const tempPos = new THREE.Vector3()
        for (const obj of effectiveObjects) {
          obj.getWorldPosition(tempPos)
          center.add(tempPos)
        }
        center.divideScalar(effectiveObjects.length)
      }

      proxyObject.quaternion.set(0, 0, 0, 1)
      proxyObject.rotation.set(0, 0, 0)
    }

    proxyObject.position.copy(center)
    proxyObject.scale.set(1, 1, 1)
    proxyObject.updateMatrixWorld(true)
  }, [effectiveObjects, pivotMode, gizmoSpace, proxyObject])

  useEffect(() => {
    syncProxyToPivot()
  }, [effectiveObjects, pivotMode, gizmoSpace, transformVersion, syncProxyToPivot])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return

    controls.setSpace(gizmoSpace)

    const handleChange = () => {
      const isHovered = controls.axis !== null
      setIsGizmoHovered(isHovered)
    }

    const handleDraggingChanged = (event: { value: boolean }) => {
      if (event.value) {
        setIsGizmoDragging(true)
      } else {
        setTimeout(() => {
          setIsGizmoDragging(false)
        }, 50)
      }
    }

    controls.addEventListener('change', handleChange)
    controls.addEventListener('dragging-changed', handleDraggingChanged)

    return () => {
      controls.removeEventListener('change', handleChange)
      controls.removeEventListener('dragging-changed', handleDraggingChanged)
      setIsGizmoHovered(false)
      setIsGizmoDragging(false)
    }
  }, [setIsGizmoHovered, setIsGizmoDragging, gizmoSpace, effectiveObjects.length])

  useEffect(() => {
    if (isFlying) {
      setIsGizmoHovered(false)
      setIsGizmoDragging(false)
      gizmoInteraction.isHovered = false
      gizmoInteraction.isDragging = false
    }
  }, [isFlying, setIsGizmoHovered, setIsGizmoDragging])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (flyState.active) return

      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return
      }

      const key = e.key.toLowerCase()
      if (key === 'w') {
        setTransformMode('translate')
      } else if (key === 'e') {
        setTransformMode('rotate')
      } else if (key === 'r') {
        setTransformMode('scale')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setTransformMode])

  const handleObjectChange = () => {
    if (!proxyStartInvRef.current || dragItemsRef.current.length === 0) return

    proxyObject.updateMatrixWorld(true)

    const deltaMatrix = new THREE.Matrix4().multiplyMatrices(
      proxyObject.matrixWorld,
      proxyStartInvRef.current
    )

    for (const item of dragItemsRef.current) {
      const newTargetWorld = new THREE.Matrix4().multiplyMatrices(
        deltaMatrix,
        item.startMatrixWorld
      )

      if (item.obj.parent) {
        const parentInverse = item.obj.parent.matrixWorld.clone().invert()
        const newTargetLocal = new THREE.Matrix4().multiplyMatrices(
          parentInverse,
          newTargetWorld
        )
        newTargetLocal.decompose(
          item.obj.position,
          item.obj.quaternion,
          item.obj.scale
        )
      } else {
        newTargetWorld.decompose(
          item.obj.position,
          item.obj.quaternion,
          item.obj.scale
        )
      }

      item.obj.rotation.setFromQuaternion(item.obj.quaternion)
      item.obj.updateMatrixWorld(true)
    }
  }

  if (effectiveObjects.length === 0 || isFlying) {
    return null
  }

  return (
    <>
      <primitive object={proxyObject} />
      <TransformControls
        ref={controlsRef}
        object={proxyObject}
        mode={transformMode}
        space={gizmoSpace}
        size={0.75}
        onObjectChange={handleObjectChange}
        onMouseDown={() => {
          setIsGizmoDragging(true)
          proxyObject.updateMatrixWorld(true)
          proxyStartInvRef.current = proxyObject.matrixWorld.clone().invert()

          dragItemsRef.current = effectiveObjects.map((obj) => {
            obj.updateMatrixWorld(true)
            return {
              obj,
              before: getObjectSnapshot(obj),
              startMatrixWorld: obj.matrixWorld.clone(),
            }
          })
        }}
        onMouseUp={() => {
          const changes: PropertyChange[] = []
          for (const item of dragItemsRef.current) {
            const endSnapshot = getObjectSnapshot(item.obj)
            if (!areSnapshotsEqual(item.before, endSnapshot)) {
              changes.push({
                id: getNodeId(item.obj),
                uuid: item.obj.uuid,
                before: item.before,
                after: endSnapshot,
              })
            }
          }

          if (changes.length > 0) {
            pushHistory({ type: 'transform', changes })
          }

          dragItemsRef.current = []
          proxyStartInvRef.current = null

          setTimeout(() => {
            setIsGizmoDragging(false)
          }, 50)

          syncProxyToPivot()
          bumpTransformVersion()
        }}
      />
    </>
  )
}
