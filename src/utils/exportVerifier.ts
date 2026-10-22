import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { exportSceneToGLB } from './exportGLB'
import { useEditorStore } from '../store/useEditorStore'

export interface VerificationRow {
  index: number
  editorName: string
  reloadedName: string
  posDiff: number
  rotDiff: number
  scaleDiff: number
  jointsMatch: string
  status: 'OK' | 'MISMATCH'
}

export async function verifyExport(): Promise<{ passed: boolean; rows: VerificationRow[] }> {
  const sceneRoot = useEditorStore.getState().sceneRoot
  if (!sceneRoot) {
    console.warn('[verifyExport] No active sceneRoot in store.')
    return { passed: false, rows: [] }
  }

  sceneRoot.updateMatrixWorld(true)

  console.log('[verifyExport] Exporting scene to GLB buffer...')
  const buffer = await exportSceneToGLB(sceneRoot)

  console.log('[verifyExport] Parsing exported GLB...')
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath('/draco/gltf/')
  const loader = new GLTFLoader()
  loader.setDRACOLoader(dracoLoader)

  const reloadedGltf = await new Promise<any>((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject)
  })
  dracoLoader.dispose()

  const editorNodes: THREE.Object3D[] = []
  function collectVisible(obj: THREE.Object3D) {
    if (!obj.visible) return
    editorNodes.push(obj)
    for (const child of obj.children) {
      collectVisible(child)
    }
  }
  collectVisible(sceneRoot)

  let reloadedRoot: THREE.Object3D = reloadedGltf.scene
  if (
    reloadedGltf.scene.children.length === 1 &&
    reloadedGltf.scene.children[0].name === THREE.PropertyBinding.sanitizeNodeName(sceneRoot.name)
  ) {
    reloadedRoot = reloadedGltf.scene.children[0]
  }

  const reloadedNodes: THREE.Object3D[] = []
  function collectReloaded(obj: THREE.Object3D) {
    reloadedNodes.push(obj)
    for (const child of obj.children) {
      collectReloaded(child)
    }
  }
  collectReloaded(reloadedRoot)

  const TOLERANCE = 1e-4
  const rows: VerificationRow[] = []
  let allMatch = true

  const maxLen = Math.max(editorNodes.length, reloadedNodes.length)
  for (let i = 0; i < maxLen; i++) {
    const eNode = editorNodes[i]
    const rNode = reloadedNodes[i]

    if (!eNode || !rNode) {
      allMatch = false
      rows.push({
        index: i,
        editorName: eNode?.name ?? '(missing)',
        reloadedName: rNode?.name ?? '(missing)',
        posDiff: -1,
        rotDiff: -1,
        scaleDiff: -1,
        jointsMatch: 'N/A',
        status: 'MISMATCH',
      })
      continue
    }

    const sanitizedEditorName = THREE.PropertyBinding.sanitizeNodeName(eNode.name)
    const nameMatch = sanitizedEditorName === rNode.name

    const posDiff = eNode.position.distanceTo(rNode.position)
    const scaleDiff = eNode.scale.distanceTo(rNode.scale)

    const q1 = eNode.quaternion
    const q2 = rNode.quaternion
    const dot = Math.abs(q1.x * q2.x + q1.y * q2.y + q1.z * q2.z + q1.w * q2.w)
    const rotDiff = Math.abs(dot - 1)

    let jointsMatch = 'N/A'
    let jointsOk = true
    if ((eNode as any).isSkinnedMesh) {
      const eSkin = eNode as THREE.SkinnedMesh
      const rSkin = rNode as THREE.SkinnedMesh
      if (rSkin.isSkinnedMesh && eSkin.skeleton && rSkin.skeleton) {
        const eJointNames = eSkin.skeleton.bones.map((b) => THREE.PropertyBinding.sanitizeNodeName(b.name))
        const rJointNames = rSkin.skeleton.bones.map((b) => b.name)
        const countMatch = eJointNames.length === rJointNames.length
        const namesMatch = countMatch && eJointNames.every((n, idx) => n === rJointNames[idx])
        jointsOk = countMatch && namesMatch
        jointsMatch = jointsOk ? `OK (${eJointNames.length})` : `FAIL (${eJointNames.length} vs ${rJointNames.length})`
      } else {
        jointsOk = false
        jointsMatch = 'FAIL (missing skin/skeleton)'
      }
    }

    const posOk = posDiff <= TOLERANCE
    const rotOk = rotDiff <= TOLERANCE
    const scaleOk = scaleDiff <= TOLERANCE

    const isRowOk = nameMatch && posOk && rotOk && scaleOk && jointsOk
    if (!isRowOk) {
      allMatch = false
    }

    rows.push({
      index: i,
      editorName: eNode.name,
      reloadedName: rNode.name,
      posDiff: Math.round(posDiff * 1e6) / 1e6,
      rotDiff: Math.round(rotDiff * 1e6) / 1e6,
      scaleDiff: Math.round(scaleDiff * 1e6) / 1e6,
      jointsMatch,
      status: isRowOk ? 'OK' : 'MISMATCH',
    })
  }

  console.table(rows)
  console.log(
    `[verifyExport] Result: ${allMatch ? 'PASS' : 'FAIL'} (Editor nodes: ${editorNodes.length}, Reloaded nodes: ${reloadedNodes.length})`
  )

  return { passed: allMatch, rows }
}

declare global {
  interface Window {
    __verifyExport?: () => Promise<{ passed: boolean; rows: VerificationRow[] }>
  }
}

if (typeof window !== 'undefined') {
  window.__verifyExport = verifyExport
}
