import { useEffect, useRef, useMemo, useState } from 'react'
import * as THREE from 'three'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEditorStore, gizmoInteraction } from '../store/useEditorStore'
import { flyState } from '../utils/flyState'

const COLOR_NORMAL = new THREE.Color('#5c768d')
const COLOR_HOVER = new THREE.Color('#90e0ef')
const COLOR_SELECTED = new THREE.Color('#00b4d8')
const COLOR_LINE = new THREE.Color('#415a77')

const UP_VECTOR = new THREE.Vector3(0, 1, 0)

function createOctahedronGeometry(): THREE.BufferGeometry {
  const vHead = [0, 0, 0]
  const vTail = [0, 1, 0]
  const vPx = [0.5, 0.1, 0]
  const vPz = [0, 0.1, 0.5]
  const vNx = [-0.5, 0.1, 0]
  const vNz = [0, 0.1, -0.5]

  const positions: number[] = [
    // Lower pyramid (head to belt)
    ...vHead, ...vPx, ...vPz,
    ...vHead, ...vPz, ...vNx,
    ...vHead, ...vNx, ...vNz,
    ...vHead, ...vNz, ...vPx,
    // Upper pyramid (belt to tail)
    ...vTail, ...vPz, ...vPx,
    ...vTail, ...vNx, ...vPz,
    ...vTail, ...vNz, ...vNx,
    ...vTail, ...vPx, ...vNz,
  ]

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

interface BoneData {
  bone: THREE.Bone
  parentBone: THREE.Bone | null
  childBones: THREE.Bone[]
}

export function BoneOverlay() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const showBones = useEditorStore((state) => state.showBones)
  const hasBones = useEditorStore((state) => state.hasBones)
  const boneSize = useEditorStore((state) => state.boneSize)
  const boneXray = useEditorStore((state) => state.boneXray)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const selectSingle = useEditorStore((state) => state.selectSingle)
  const toggleSelection = useEditorStore((state) => state.toggleSelection)
  const structureVersion = useEditorStore((state) => state.structureVersion)

  const instancedMeshRef = useRef<THREE.InstancedMesh>(null)
  const lineSegmentsRef = useRef<THREE.LineSegments>(null)
  const linesGeometryRef = useRef<THREE.BufferGeometry>(null)

  const [boneCount, setBoneCount] = useState(0)
  const bonesDataRef = useRef<BoneData[]>([])
  const boneIndexMapRef = useRef<Map<string, number>>(new Map())
  const hoveredBoneUuidRef = useRef<string | null>(null)
  const tailPositionsRef = useRef<THREE.Vector3[]>([])

  const octaGeometry = useMemo(() => createOctahedronGeometry(), [])

  const boneMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.15,
      depthTest: !boneXray,
      depthWrite: !boneXray,
      transparent: boneXray,
      opacity: boneXray ? 0.92 : 1.0,
      side: THREE.DoubleSide,
    })
  }, [boneXray])

  const lineMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: COLOR_LINE,
      depthTest: !boneXray,
      depthWrite: !boneXray,
      transparent: boneXray,
      opacity: boneXray ? 0.8 : 1.0,
      linewidth: 1,
    })
  }, [boneXray])

  useEffect(() => {
    if (!sceneRoot || !hasBones) {
      bonesDataRef.current = []
      boneIndexMapRef.current.clear()
      tailPositionsRef.current = []
      setBoneCount(0)
      return
    }

    const boneList: THREE.Bone[] = []
    sceneRoot.traverse((node) => {
      if ((node as any).isBone || node.type === 'Bone') {
        boneList.push(node as THREE.Bone)
      }
    })

    const indexMap = new Map<string, number>()
    boneList.forEach((b, idx) => indexMap.set(b.uuid, idx))

    const dataList: BoneData[] = boneList.map((bone) => {
      const parent = bone.parent
      const parentBone =
        parent && ((parent as any).isBone || parent.type === 'Bone')
          ? (parent as THREE.Bone)
          : null

      const childBones = bone.children.filter(
        (c) => (c as any).isBone || c.type === 'Bone'
      ) as THREE.Bone[]

      return {
        bone,
        parentBone,
        childBones,
      }
    })

    bonesDataRef.current = dataList
    boneIndexMapRef.current = indexMap
    tailPositionsRef.current = dataList.map(() => new THREE.Vector3())
    setBoneCount(dataList.length)

    const mesh = instancedMeshRef.current
    if (mesh) {
      for (let i = 0; i < dataList.length; i++) {
        mesh.setColorAt(i, COLOR_NORMAL)
      }
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true
      }
    }
  }, [sceneRoot, hasBones, structureVersion])

  // Frame-by-frame updates without React re-renders
  useFrame(({ camera, size }) => {
    if (!showBones || bonesDataRef.current.length === 0) return

    const mesh = instancedMeshRef.current
    if (!mesh) return

    const count = bonesDataRef.current.length
    const pixelRatio =
      (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) /
      Math.max(size.height, 1)

    const modelBBox = new THREE.Box3()
    if (sceneRoot) {
      modelBBox.setFromObject(sceneRoot)
    }
    const modelExtent = modelBBox.isEmpty()
      ? 2.0
      : modelBBox.getSize(new THREE.Vector3()).length()
    const defaultLeafLen = Math.max(0.04, modelExtent * 0.025)

    const headPos = new THREE.Vector3()
    const tailPos = new THREE.Vector3()
    const dirVec = new THREE.Vector3()
    const scaleVec = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const transformMat = new THREE.Matrix4()
    const tempVec = new THREE.Vector3()
    const tempQuat = new THREE.Quaternion()

    const gapLinePoints: THREE.Vector3[] = []

    // 1. First pass: compute all tail positions
    for (let i = 0; i < count; i++) {
      const item = bonesDataRef.current[i]
      item.bone.getWorldPosition(headPos)

      if (item.childBones.length === 1) {
        item.childBones[0].getWorldPosition(tailPos)
        if (tailPos.distanceTo(headPos) < 0.0001) {
          // Coincident child: treat like leaf
          if (item.parentBone) {
            item.parentBone.getWorldPosition(tempVec)
            const parentLen = tempVec.distanceTo(headPos)
            if (parentLen > 0.0001) {
              dirVec.subVectors(headPos, tempVec).normalize()
              tailPos.copy(headPos).addScaledVector(dirVec, 0.5 * parentLen)
            } else {
              dirVec.set(0, 1, 0).applyQuaternion(item.bone.getWorldQuaternion(tempQuat))
              tailPos.copy(headPos).addScaledVector(dirVec, defaultLeafLen)
            }
          } else {
            dirVec.set(0, 1, 0).applyQuaternion(item.bone.getWorldQuaternion(tempQuat))
            tailPos.copy(headPos).addScaledVector(dirVec, defaultLeafLen)
          }
        }
      } else if (item.childBones.length > 1) {
        tailPos.set(0, 0, 0)
        for (const child of item.childBones) {
          child.getWorldPosition(tempVec)
          tailPos.add(tempVec)
        }
        tailPos.divideScalar(item.childBones.length)
        if (tailPos.distanceTo(headPos) < 0.0001) {
          dirVec.set(0, 1, 0).applyQuaternion(item.bone.getWorldQuaternion(tempQuat))
          tailPos.copy(headPos).addScaledVector(dirVec, defaultLeafLen)
        }
      } else {
        // Leaf bone
        if (item.parentBone) {
          item.parentBone.getWorldPosition(tempVec)
          const parentLen = tempVec.distanceTo(headPos)
          if (parentLen > 0.0001) {
            dirVec.subVectors(headPos, tempVec).normalize()
            tailPos.copy(headPos).addScaledVector(dirVec, 0.5 * parentLen)
          } else {
            dirVec.set(0, 1, 0).applyQuaternion(item.bone.getWorldQuaternion(tempQuat))
            tailPos.copy(headPos).addScaledVector(dirVec, defaultLeafLen)
          }
        } else {
          dirVec.set(0, 1, 0).applyQuaternion(item.bone.getWorldQuaternion(tempQuat))
          tailPos.copy(headPos).addScaledVector(dirVec, defaultLeafLen)
        }
      }

      tailPositionsRef.current[i].copy(tailPos)
    }

    // 2. Second pass: build instance matrices and check gaps
    for (let i = 0; i < count; i++) {
      const item = bonesDataRef.current[i]
      item.bone.getWorldPosition(headPos)
      const tail = tailPositionsRef.current[i]

      const boneLen = Math.max(0.0001, headPos.distanceTo(tail))
      const baseWidth = 0.1 * boneLen * boneSize
      const camDist = camera.position.distanceTo(headPos)
      const minScreenPxWidth = 5 * camDist * pixelRatio
      const boneWidth = Math.max(baseWidth, minScreenPxWidth)

      dirVec.subVectors(tail, headPos).normalize()
      quat.setFromUnitVectors(UP_VECTOR, dirVec)
      scaleVec.set(boneWidth, boneLen, boneWidth)
      transformMat.compose(headPos, quat, scaleVec)

      mesh.setMatrixAt(i, transformMat)

      // Color instance
      const isSelected = selectedUuids.includes(item.bone.uuid)
      const isHovered = hoveredBoneUuidRef.current === item.bone.uuid

      if (isSelected) {
        mesh.setColorAt(i, COLOR_SELECTED)
      } else if (isHovered) {
        mesh.setColorAt(i, COLOR_HOVER)
      } else {
        mesh.setColorAt(i, COLOR_NORMAL)
      }

      // Check gap between parent tail and this bone's head
      if (item.parentBone) {
        const parentIdx = boneIndexMapRef.current.get(item.parentBone.uuid)
        if (parentIdx !== undefined) {
          const pTail = tailPositionsRef.current[parentIdx]
          if (pTail && pTail.distanceTo(headPos) > 0.001) {
            gapLinePoints.push(pTail.clone(), headPos.clone())
          }
        }
      }
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
    }

    // Update gap lines geometry
    if (linesGeometryRef.current) {
      linesGeometryRef.current.setFromPoints(gapLinePoints)
    }
  })

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (flyState.active || Date.now() - flyState.exitedAt < 150) return
    if (gizmoInteraction.isHovered || gizmoInteraction.isDragging) return
    if (e.delta > 3) return

    const instanceId = e.instanceId
    if (instanceId === undefined) return

    const item = bonesDataRef.current[instanceId]
    if (!item) return

    e.stopPropagation()

    if (e.altKey || e.nativeEvent.altKey) {
      toggleSelection(item.bone.uuid)
    } else {
      selectSingle(item.bone.uuid)
    }
  }

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    if (flyState.active || Date.now() - flyState.exitedAt < 150) return
    if (gizmoInteraction.isHovered || gizmoInteraction.isDragging) return
    const instanceId = e.instanceId
    if (instanceId !== undefined && bonesDataRef.current[instanceId]) {
      hoveredBoneUuidRef.current = bonesDataRef.current[instanceId].bone.uuid
    }
  }

  const handlePointerOut = () => {
    hoveredBoneUuidRef.current = null
  }

  if (!hasBones || !showBones || boneCount === 0) {
    return null
  }

  return (
    <group renderOrder={boneXray ? 9999 : 0}>
      <instancedMesh
        ref={instancedMeshRef}
        args={[octaGeometry, boneMaterial, boneCount]}
        frustumCulled={false}
        renderOrder={boneXray ? 9999 : 0}
        onClick={handleClick}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        userData={{
          isBoneHandle: true,
          boneUuids: bonesDataRef.current.map((d) => d.bone.uuid),
        }}
      />
      <lineSegments
        ref={lineSegmentsRef}
        material={lineMaterial}
        renderOrder={boneXray ? 9998 : 0}
        raycast={() => null}
      >
        <bufferGeometry ref={linesGeometryRef} />
      </lineSegments>
    </group>
  )
}
