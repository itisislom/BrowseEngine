import { create } from 'zustand'
import type * as THREE from 'three'
import { flyState } from '../utils/flyState'
import { clearFlyPin } from '../utils/flyAim'
import { initNodeRegistry, getNodeById, getNodeId } from '../utils/nodeRegistry'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type PivotMode = 'center' | 'origin'
export type GizmoSpace = 'world' | 'local'

export interface TransformSnapshot {
  position: [number, number, number]
  rotation: [number, number, number]
  quaternion?: [number, number, number, number]
  scale: [number, number, number]
  visible: boolean
}

export interface TransformPropertyChange {
  id?: number
  uuid: string
  before: TransformSnapshot
  after: TransformSnapshot
}

export type PropertyChange = TransformPropertyChange

export interface TransformHistoryEntry {
  type: 'transform'
  changes: TransformPropertyChange[]
}

export interface RenameHistoryEntry {
  type: 'rename'
  id: number
  oldName: string
  newName: string
}

export interface DeleteHistoryEntry {
  type: 'delete'
  roots: { id: number; parentId: number; index: number }[]
  selectionBefore: string[]
}

export type HistoryEntry =
  | TransformHistoryEntry
  | RenameHistoryEntry
  | DeleteHistoryEntry

export function getObjectSnapshot(obj: THREE.Object3D): TransformSnapshot {
  return {
    position: [obj.position.x, obj.position.y, obj.position.z],
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
    scale: [obj.scale.x, obj.scale.y, obj.scale.z],
    visible: obj.visible,
  }
}

export function applySnapshot(obj: THREE.Object3D, snapshot: TransformSnapshot): void {
  obj.position.set(...snapshot.position)
  if (snapshot.quaternion) {
    obj.quaternion.set(...snapshot.quaternion)
    obj.rotation.setFromQuaternion(obj.quaternion)
  } else {
    obj.rotation.set(...snapshot.rotation)
  }
  obj.scale.set(...snapshot.scale)
  obj.visible = snapshot.visible
  obj.updateMatrixWorld(true)
}

export function areSnapshotsEqual(a: TransformSnapshot, b: TransformSnapshot): boolean {
  const posEq =
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2]
  const scaleEq =
    a.scale[0] === b.scale[0] &&
    a.scale[1] === b.scale[1] &&
    a.scale[2] === b.scale[2]
  const visEq = a.visible === b.visible
  if (!posEq || !scaleEq || !visEq) return false

  if (a.quaternion && b.quaternion) {
    return (
      a.quaternion[0] === b.quaternion[0] &&
      a.quaternion[1] === b.quaternion[1] &&
      a.quaternion[2] === b.quaternion[2] &&
      a.quaternion[3] === b.quaternion[3]
    )
  }

  return (
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2]
  )
}

export function detectSkeletons(scene: THREE.Object3D | null): {
  hasBones: boolean
  initialTransforms: Record<string, TransformSnapshot>
} {
  if (!scene) return { hasBones: false, initialTransforms: {} }
  let hasBones = false
  const initialTransforms: Record<string, TransformSnapshot> = {}

  scene.traverse((node) => {
    if ((node as any).isBone || node.type === 'Bone') {
      hasBones = true
      initialTransforms[node.uuid] = getObjectSnapshot(node)
    }
    if ((node as any).isSkinnedMesh) {
      node.frustumCulled = false
      const skeleton = (node as any).skeleton
      if (skeleton && skeleton.bones && skeleton.bones.length > 0) {
        hasBones = true
        for (const b of skeleton.bones) {
          if (!initialTransforms[b.uuid]) {
            initialTransforms[b.uuid] = getObjectSnapshot(b)
          }
        }
      }
    }
  })

  return { hasBones, initialTransforms }
}

export function filterAncestors(objects: THREE.Object3D[]): THREE.Object3D[] {
  const set = new Set(objects)
  return objects.filter((obj) => {
    let curr = obj.parent
    while (curr) {
      if (set.has(curr)) return false
      curr = curr.parent
    }
    return true
  })
}

export function canDeleteRoots(
  sceneRoot: THREE.Object3D,
  rootsToDelete: THREE.Object3D[]
): { allowed: boolean; reason?: string } {
  const deletingSet = new Set<THREE.Object3D>()
  for (const root of rootsToDelete) {
    root.traverse((node) => deletingSet.add(node))
  }

  let blockedReason: string | undefined
  sceneRoot.traverse((node) => {
    if (blockedReason) return
    if ((node as any).isSkinnedMesh && !deletingSet.has(node)) {
      const skinnedMesh = node as any
      const skeleton = skinnedMesh.skeleton
      if (skeleton && Array.isArray(skeleton.bones)) {
        for (const bone of skeleton.bones) {
          if (deletingSet.has(bone)) {
            const meshName = skinnedMesh.name || 'SkinnedMesh'
            blockedReason = `Bone is used by mesh ${meshName}: delete the mesh along with bones`
            break
          }
        }
      }
    }
  })

  if (blockedReason) {
    return { allowed: false, reason: blockedReason }
  }
  return { allowed: true }
}

export const gizmoInteraction = {
  isHovered: false,
  isDragging: false,
}

interface EditorState {
  modelUrl: string | null
  fileName: string | null
  fileBlob: Blob | null
  sceneRoot: THREE.Group | null
  hasBones: boolean
  showBones: boolean
  boneSize: number
  boneXray: boolean
  initialBoneTransforms: Record<string, TransformSnapshot>
  selectedUuids: string[]
  transformMode: TransformMode
  pivotMode: PivotMode
  gizmoSpace: GizmoSpace
  isGizmoHovered: boolean
  isGizmoDragging: boolean
  transformVersion: number
  structureVersion: number
  editingNodeId: number | null
  animationClipsCount: number
  past: HistoryEntry[]
  future: HistoryEntry[]
  setModel: (
    url: string | null,
    fileName: string | null,
    scene: THREE.Group | null,
    blob?: Blob | null,
    animationClipsCount?: number
  ) => void
  restoreSession: (data: {
    modelUrl: string
    fileName: string
    sceneRoot: THREE.Group
    fileBlob: Blob
    selectedUuids: string[]
    transformMode: TransformMode
    pivotMode: PivotMode
    past: HistoryEntry[]
    future: HistoryEntry[]
    initialBoneTransforms?: Record<string, TransformSnapshot>
    animationClipsCount?: number
  }) => void
  selectSingle: (uuid: string | null) => void
  toggleSelection: (uuid: string) => void
  setTransformMode: (mode: TransformMode) => void
  setPivotMode: (mode: PivotMode) => void
  setGizmoSpace: (space: GizmoSpace) => void
  setShowBones: (show: boolean) => void
  setBoneSize: (size: number) => void
  setBoneXray: (xray: boolean) => void
  resetBonePose: (targetUuids?: string[], property?: 'rotation' | 'position' | 'scale' | 'all') => void
  isFlying: boolean
  statusMessage: string | null
  setIsFlying: (isFlying: boolean) => void
  setStatusMessage: (msg: string | null) => void
  setIsGizmoHovered: (hovered: boolean) => void
  setIsGizmoDragging: (dragging: boolean) => void
  bumpTransformVersion: () => void
  bumpStructureVersion: () => void
  setEditingNodeId: (id: number | null) => void
  renameNode: (id: number, newName: string) => void
  deleteNodes: (targetUuids?: string[]) => boolean
  pushHistory: (entry: HistoryEntry | { changes: PropertyChange[] }) => void
  undo: () => void
  redo: () => void
  reset: () => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  modelUrl: null,
  fileName: null,
  fileBlob: null,
  sceneRoot: null,
  hasBones: false,
  showBones: false,
  boneSize: 1.0,
  boneXray: true,
  initialBoneTransforms: {},
  selectedUuids: [],
  transformMode: 'translate',
  pivotMode: 'center',
  isFlying: false,
  statusMessage: null,
  setIsFlying: (isFlying) => set({ isFlying }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  gizmoSpace: 'world',
  isGizmoHovered: false,
  isGizmoDragging: false,
  transformVersion: 0,
  structureVersion: 0,
  editingNodeId: null,
  animationClipsCount: 0,
  past: [],
  future: [],
  setModel: (modelUrl, fileName, sceneRoot, fileBlob = null, animationClipsCount = 0) => {
    flyState.active = false
    flyState.exitedAt = Date.now()
    clearFlyPin()
    if (sceneRoot) {
      initNodeRegistry(sceneRoot)
    }
    const { hasBones, initialTransforms } = detectSkeletons(sceneRoot)
    set({
      isFlying: false,
      modelUrl,
      fileName,
      fileBlob,
      sceneRoot,
      hasBones,
      showBones: false,
      boneSize: 1.0,
      boneXray: true,
      initialBoneTransforms: initialTransforms,
      selectedUuids: [],
      gizmoSpace: 'world',
      isGizmoHovered: false,
      isGizmoDragging: false,
      transformVersion: 0,
      structureVersion: 0,
      editingNodeId: null,
      animationClipsCount: animationClipsCount || 0,
      past: [],
      future: [],
    })
  },
  restoreSession: ({
    modelUrl,
    fileName,
    sceneRoot,
    fileBlob,
    selectedUuids,
    transformMode,
    pivotMode,
    past,
    future,
    initialBoneTransforms,
    animationClipsCount = 0,
  }) => {
    if (sceneRoot) {
      initNodeRegistry(sceneRoot)
    }
    const { hasBones, initialTransforms } = detectSkeletons(sceneRoot)
    set({
      modelUrl,
      fileName,
      fileBlob,
      sceneRoot,
      hasBones,
      showBones: false,
      boneSize: 1.0,
      boneXray: true,
      initialBoneTransforms: initialBoneTransforms || initialTransforms,
      selectedUuids,
      transformMode,
      pivotMode,
      gizmoSpace: 'world',
      past,
      future,
      isGizmoHovered: false,
      isGizmoDragging: false,
      transformVersion: 0,
      structureVersion: 0,
      editingNodeId: null,
      animationClipsCount: animationClipsCount || 0,
    })
  },
  selectSingle: (uuid) =>
    set({
      selectedUuids: uuid ? [uuid] : [],
    }),
  toggleSelection: (uuid) =>
    set((state) => {
      const exists = state.selectedUuids.includes(uuid)
      return {
        selectedUuids: exists
          ? state.selectedUuids.filter((id) => id !== uuid)
          : [...state.selectedUuids, uuid],
      }
    }),
  setTransformMode: (transformMode) => set({ transformMode }),
  setPivotMode: (pivotMode) => set({ pivotMode }),
  setGizmoSpace: (gizmoSpace) => set({ gizmoSpace }),
  setShowBones: (showBones) =>
    set((state) => {
      if (!showBones && state.sceneRoot) {
        const boneUuids = new Set<string>()
        state.sceneRoot.traverse((node) => {
          if ((node as any).isBone || node.type === 'Bone') {
            boneUuids.add(node.uuid)
          }
        })
        const filteredSelected = state.selectedUuids.filter((id) => !boneUuids.has(id))
        return { showBones, selectedUuids: filteredSelected }
      }
      return { showBones }
    }),
  setBoneSize: (boneSize) => set({ boneSize }),
  setBoneXray: (boneXray) => set({ boneXray }),
  resetBonePose: (targetUuids, property = 'all') => {
    const { sceneRoot, initialBoneTransforms, pushHistory } = get()
    if (!sceneRoot) return

    const uuidsToReset =
      targetUuids && targetUuids.length > 0
        ? targetUuids
        : Object.keys(initialBoneTransforms)

    const changes: TransformPropertyChange[] = []
    for (const uuid of uuidsToReset) {
      const initial = initialBoneTransforms[uuid]
      if (!initial) continue
      const obj =
        sceneRoot.uuid === uuid
          ? sceneRoot
          : sceneRoot.getObjectByProperty('uuid', uuid)
      if (obj) {
        const current = getObjectSnapshot(obj)
        const targetSnapshot: TransformSnapshot = {
          position: property === 'rotation' || property === 'scale' ? [...current.position] : [...initial.position],
          rotation: property === 'position' || property === 'scale' ? [...current.rotation] : [...initial.rotation],
          quaternion: property === 'position' || property === 'scale' ? (current.quaternion ? [...current.quaternion] : undefined) : (initial.quaternion ? [...initial.quaternion] : undefined),
          scale: property === 'position' || property === 'rotation' ? [...current.scale] : [...initial.scale],
          visible: current.visible,
        }

        if (!areSnapshotsEqual(current, targetSnapshot)) {
          changes.push({
            id: getNodeId(obj),
            uuid,
            before: current,
            after: targetSnapshot,
          })
          applySnapshot(obj, targetSnapshot)
        }
      }
    }

    if (changes.length > 0) {
      sceneRoot.updateMatrixWorld(true)
      pushHistory({ type: 'transform', changes })
      set((state) => ({ transformVersion: state.transformVersion + 1 }))
    }
  },
  setIsGizmoHovered: (isGizmoHovered) => {
    gizmoInteraction.isHovered = isGizmoHovered
    set({ isGizmoHovered })
  },
  setIsGizmoDragging: (isGizmoDragging) => {
    gizmoInteraction.isDragging = isGizmoDragging
    set({ isGizmoDragging })
  },
  bumpTransformVersion: () =>
    set((state) => ({ transformVersion: state.transformVersion + 1 })),
  bumpStructureVersion: () =>
    set((state) => ({ structureVersion: state.structureVersion + 1 })),
  setEditingNodeId: (editingNodeId) => set({ editingNodeId }),
  renameNode: (id, newName) => {
    const node = getNodeById(id)
    if (!node) return
    const trimmed = newName.trim()
    if (!trimmed) {
      set({ editingNodeId: null })
      return
    }
    if (node.name === trimmed) {
      set({ editingNodeId: null })
      return
    }

    const oldName = node.name
    node.name = trimmed
    if (node.userData && typeof node.userData === 'object') {
      if ('name' in node.userData) {
        node.userData.name = trimmed
      }
    }

    get().pushHistory({
      type: 'rename',
      id,
      oldName,
      newName: trimmed,
    })

    set((state) => ({
      structureVersion: state.structureVersion + 1,
      editingNodeId: null,
    }))
  },
  deleteNodes: (targetUuids) => {
    const { sceneRoot, selectedUuids, pushHistory, setStatusMessage } = get()
    if (!sceneRoot) return false

    const uuids = targetUuids && targetUuids.length > 0 ? targetUuids : selectedUuids
    if (uuids.length === 0) return false

    const objects: THREE.Object3D[] = []
    for (const uuid of uuids) {
      if (uuid === sceneRoot.uuid) continue
      const obj = sceneRoot.getObjectByProperty('uuid', uuid)
      if (obj && obj.parent) {
        objects.push(obj)
      }
    }

    if (objects.length === 0) return false

    const rootsToDelete = filterAncestors(objects)
    if (rootsToDelete.length === 0) return false

    const check = canDeleteRoots(sceneRoot, rootsToDelete)
    if (!check.allowed) {
      setStatusMessage(check.reason || 'Cannot delete node')
      return false
    }

    const rootsInfo: { id: number; parentId: number; index: number }[] = []
    for (const root of rootsToDelete) {
      const id = getNodeId(root)
      const parentId = getNodeId(root.parent!)
      if (id !== undefined && parentId !== undefined) {
        const index = root.parent!.children.indexOf(root)
        rootsInfo.push({ id, parentId, index })
      }
    }

    if (rootsInfo.length === 0) return false

    const deletedUuids = new Set<string>()
    for (const root of rootsToDelete) {
      root.traverse((child) => deletedUuids.add(child.uuid))
      if (root.parent) {
        root.parent.remove(root)
      }
    }

    sceneRoot.updateMatrixWorld(true)

    pushHistory({
      type: 'delete',
      roots: rootsInfo,
      selectionBefore: selectedUuids,
    })

    const count = rootsToDelete.length
    setStatusMessage(`Deleted: ${count} node${count === 1 ? '' : 's'} (Ctrl+Z to undo)`)

    set((state) => ({
      selectedUuids: state.selectedUuids.filter((id) => !deletedUuids.has(id)),
      structureVersion: state.structureVersion + 1,
      editingNodeId: null,
      isGizmoHovered: false,
      isGizmoDragging: false,
    }))

    return true
  },
  pushHistory: (entry) => {
    const normalized: HistoryEntry =
      'type' in entry ? entry : { type: 'transform', changes: entry.changes }
    if (normalized.type === 'transform' && normalized.changes.length === 0) return
    set((state) => ({
      past: [...state.past, normalized],
      future: [],
    }))
  },
  undo: () => {
    const { past, future, sceneRoot } = get()
    if (past.length === 0 || !sceneRoot) return

    const lastEntry = past[past.length - 1]
    const newPast = past.slice(0, past.length - 1)

    if (lastEntry.type === 'transform') {
      for (const change of lastEntry.changes) {
        const target =
          (change.id !== undefined ? getNodeById(change.id) : null) ||
          (sceneRoot.uuid === change.uuid
            ? sceneRoot
            : sceneRoot.getObjectByProperty('uuid', change.uuid))
        if (target) {
          applySnapshot(target, change.before)
        }
      }
      sceneRoot.updateMatrixWorld(true)
      set((state) => ({
        past: newPast,
        future: [lastEntry, ...future],
        transformVersion: state.transformVersion + 1,
      }))
    } else if (lastEntry.type === 'rename') {
      const node = getNodeById(lastEntry.id)
      if (node) {
        node.name = lastEntry.oldName
        if (node.userData && typeof node.userData === 'object' && 'name' in node.userData) {
          node.userData.name = lastEntry.oldName
        }
      }
      set((state) => ({
        past: newPast,
        future: [lastEntry, ...future],
        structureVersion: state.structureVersion + 1,
      }))
    } else if (lastEntry.type === 'delete') {
      const sorted = [...lastEntry.roots].sort((a, b) => a.index - b.index)
      const restoredUuids: string[] = []
      for (const item of sorted) {
        const node = getNodeById(item.id)
        const parent = getNodeById(item.parentId) || (item.parentId === 0 ? sceneRoot : null)
        if (node && parent) {
          const idx = Math.min(item.index, parent.children.length)
          parent.children.splice(idx, 0, node)
          node.parent = parent
          restoredUuids.push(node.uuid)
        }
      }
      sceneRoot.updateMatrixWorld(true)
      set((state) => ({
        past: newPast,
        future: [lastEntry, ...future],
        selectedUuids: restoredUuids.length > 0 ? restoredUuids : lastEntry.selectionBefore,
        structureVersion: state.structureVersion + 1,
        editingNodeId: null,
      }))
    }
  },
  redo: () => {
    const { past, future, sceneRoot } = get()
    if (future.length === 0 || !sceneRoot) return

    const nextEntry = future[0]
    const newFuture = future.slice(1)

    if (nextEntry.type === 'transform') {
      for (const change of nextEntry.changes) {
        const target =
          (change.id !== undefined ? getNodeById(change.id) : null) ||
          (sceneRoot.uuid === change.uuid
            ? sceneRoot
            : sceneRoot.getObjectByProperty('uuid', change.uuid))
        if (target) {
          applySnapshot(target, change.after)
        }
      }
      sceneRoot.updateMatrixWorld(true)
      set((state) => ({
        past: [...past, nextEntry],
        future: newFuture,
        transformVersion: state.transformVersion + 1,
      }))
    } else if (nextEntry.type === 'rename') {
      const node = getNodeById(nextEntry.id)
      if (node) {
        node.name = nextEntry.newName
        if (node.userData && typeof node.userData === 'object' && 'name' in node.userData) {
          node.userData.name = nextEntry.newName
        }
      }
      set((state) => ({
        past: [...past, nextEntry],
        future: newFuture,
        structureVersion: state.structureVersion + 1,
      }))
    } else if (nextEntry.type === 'delete') {
      const deletedUuids = new Set<string>()
      for (const item of nextEntry.roots) {
        const node = getNodeById(item.id)
        if (node) {
          node.traverse((child) => deletedUuids.add(child.uuid))
          if (node.parent) {
            node.parent.remove(node)
          }
        }
      }
      sceneRoot.updateMatrixWorld(true)
      set((state) => ({
        past: [...past, nextEntry],
        future: newFuture,
        selectedUuids: state.selectedUuids.filter((id) => !deletedUuids.has(id)),
        structureVersion: state.structureVersion + 1,
        editingNodeId: null,
        isGizmoHovered: false,
        isGizmoDragging: false,
      }))
    }
  },
  reset: () => {
    gizmoInteraction.isHovered = false
    gizmoInteraction.isDragging = false
    flyState.active = false
    flyState.exitedAt = Date.now()
    clearFlyPin()
    set({
      isFlying: false,
      statusMessage: null,
      modelUrl: null,
      fileName: null,
      fileBlob: null,
      sceneRoot: null,
      hasBones: false,
      showBones: false,
      boneSize: 1.0,
      boneXray: true,
      initialBoneTransforms: {},
      selectedUuids: [],
      transformMode: 'translate',
      pivotMode: 'center',
      gizmoSpace: 'world',
      isGizmoHovered: false,
      isGizmoDragging: false,
      transformVersion: 0,
      structureVersion: 0,
      editingNodeId: null,
      animationClipsCount: 0,
      past: [],
      future: [],
    })
  },
}))
