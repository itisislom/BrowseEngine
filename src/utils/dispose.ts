import * as THREE from 'three'
import { getAllRegisteredNodes, clearNodeRegistry } from './nodeRegistry'

function disposeMaterial(material: THREE.Material): void {
  const mat = material as unknown as Record<string, unknown>
  for (const key of Object.keys(mat)) {
    const value = mat[key]
    if (value && typeof value === 'object' && value instanceof THREE.Texture) {
      value.dispose()
    }
  }
  material.dispose()
}

function disposeNodeResources(node: THREE.Object3D): void {
  if ((node as THREE.Mesh).isMesh) {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) {
      mesh.geometry.dispose()
    }
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
          disposeMaterial(mat)
        }
      } else {
        disposeMaterial(mesh.material)
      }
    }
  }
}

export function disposeHierarchy(root: THREE.Object3D | null): void {
  const registered = getAllRegisteredNodes()
  if (registered.length > 0) {
    for (const node of registered) {
      disposeNodeResources(node)
    }
    clearNodeRegistry()
  } else if (root) {
    root.traverse(disposeNodeResources)
  }

  if (root) {
    while (root.children.length > 0) {
      root.remove(root.children[0])
    }
  }
}

export function revokeBlobUrl(url: string | null): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}
