import * as THREE from 'three'
import { formatNodeName } from '../components/SceneTree'

export interface FlyHit {
  hit: boolean
  object: THREE.Mesh | null
  point: THREE.Vector3
  normal: THREE.Vector3
  distance: number
}

export interface FlyPinnedPoint {
  point: THREE.Vector3
  normal: THREE.Vector3
  objectName: string
}

export interface FlyAimState {
  hit: boolean
  object: THREE.Mesh | null
  point: THREE.Vector3
  normal: THREE.Vector3
  distance: number
  pinnedPoint: FlyPinnedPoint | null
}

export const CLEAR_PIN_ON_EXIT = true

export const flyAim: FlyAimState = {
  hit: false,
  object: null,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
  pinnedPoint: null,
}

const raycaster = new THREE.Raycaster()
const screenCenter = new THREE.Vector2(0, 0)
const normalMatrix = new THREE.Matrix3()
const candidateMeshes: THREE.Mesh[] = []

function isEffectivelyVisible(obj: THREE.Object3D): boolean {
  let curr: THREE.Object3D | null = obj
  while (curr) {
    if (!curr.visible) return false
    curr = curr.parent
  }
  return true
}

function collectMeshes(root: THREE.Object3D): void {
  candidateMeshes.length = 0
  root.traverse((node) => {
    if (!isEffectivelyVisible(node)) return
    if ('isMesh' in node && (node as any).isMesh) {
      if ((node as any).isLine || (node as any).isPoints) return
      const mesh = node as THREE.Mesh
      if ((mesh as any).isSkinnedMesh) {
        const sm = mesh as THREE.SkinnedMesh
        sm.computeBoundingSphere()
        if (sm.boundingBox) {
          sm.computeBoundingBox()
        }
      }
      candidateMeshes.push(mesh)
    }
  })
}

export function performRaycast(camera: THREE.Camera, sceneRoot: THREE.Object3D | null): FlyHit {
  if (!sceneRoot) {
    flyAim.hit = false
    flyAim.object = null
    flyAim.distance = 0
    return {
      hit: false,
      object: null,
      point: flyAim.point,
      normal: flyAim.normal,
      distance: 0,
    }
  }

  collectMeshes(sceneRoot)
  raycaster.setFromCamera(screenCenter, camera)

  const intersects = raycaster.intersectObjects(candidateMeshes, false)

  if (intersects.length > 0) {
    const hit = intersects[0]
    const mesh = hit.object as THREE.Mesh
    flyAim.hit = true
    flyAim.object = mesh
    flyAim.point.copy(hit.point)
    flyAim.distance = hit.distance

    if (hit.face) {
      normalMatrix.getNormalMatrix(mesh.matrixWorld)
      flyAim.normal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize()
    } else {
      flyAim.normal.set(0, 1, 0)
    }

    return {
      hit: true,
      object: mesh,
      point: flyAim.point,
      normal: flyAim.normal,
      distance: hit.distance,
    }
  }

  flyAim.hit = false
  flyAim.object = null
  flyAim.distance = 0
  return {
    hit: false,
    object: null,
    point: flyAim.point,
    normal: flyAim.normal,
    distance: 0,
  }
}

let lastAimTime = 0
export function tickFlyAim(camera: THREE.Camera, sceneRoot: THREE.Object3D | null, now: number): void {
  if (now - lastAimTime < 32) return
  lastAimTime = now
  performRaycast(camera, sceneRoot)
}

export function getSanitizedObjectName(obj: THREE.Object3D): string {
  const parentIndex = obj.parent ? obj.parent.children.indexOf(obj) : 0
  return formatNodeName(obj, parentIndex)
}

export function resetFlyAim(): void {
  flyAim.hit = false
  flyAim.object = null
  flyAim.distance = 0
  if (CLEAR_PIN_ON_EXIT) {
    flyAim.pinnedPoint = null
  }
}

export function clearFlyPin(): void {
  if (CLEAR_PIN_ON_EXIT) {
    flyAim.pinnedPoint = null
  }
}

export function formatCoord(val: number): string {
  const rounded = Math.abs(val) < 0.0005 ? 0 : val
  return rounded.toFixed(3)
}

export function formatGodotVector3(v: THREE.Vector3): string {
  return `Vector3(${formatCoord(v.x)}, ${formatCoord(v.y)}, ${formatCoord(v.z)})`
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (err) {
    console.warn('Clipboard writeText failed:', err)
  }
  return false
}

