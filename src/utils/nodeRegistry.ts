import type * as THREE from 'three'

let nextNodeId = 1
const idToNodeMap = new Map<number, THREE.Object3D>()
const nodeToIdMap = new WeakMap<THREE.Object3D, number>()

export function clearNodeRegistry(): void {
  idToNodeMap.clear()
  nextNodeId = 1
}

export function initNodeRegistry(root: THREE.Object3D): void {
  clearNodeRegistry()
  function register(node: THREE.Object3D) {
    const id = nextNodeId++
    idToNodeMap.set(id, node)
    nodeToIdMap.set(node, id)
    for (const child of node.children) {
      register(child)
    }
  }
  register(root)
}

export function getNodeId(node: THREE.Object3D): number | undefined {
  return nodeToIdMap.get(node)
}

export function getNodeById(id: number): THREE.Object3D | undefined {
  return idToNodeMap.get(id)
}

export function getAllRegisteredNodes(): THREE.Object3D[] {
  return Array.from(idToNodeMap.values())
}

export function getAllRegisteredEntries(): [number, THREE.Object3D][] {
  return Array.from(idToNodeMap.entries())
}
