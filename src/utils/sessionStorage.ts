import type * as THREE from 'three'
import type {
  TransformSnapshot,
  TransformMode,
  PivotMode,
  HistoryEntry,
} from '../store/useEditorStore'
import { getObjectSnapshot, applySnapshot } from '../store/useEditorStore'
import { getNodeId, getNodeById, getAllRegisteredEntries } from './nodeRegistry'

const DB_NAME = 'BrowseEngineDB'
const DB_VERSION = 2
const STORE_NAME = 'sessions'
const SESSION_KEY = 'current_session'

export interface SavedNodeRecord {
  id: number
  name: string
  snapshot: TransformSnapshot
  visible: boolean
}

export interface SavedSession {
  id: string
  version: 2
  fileName: string
  fileBlob: Blob
  selectedIds: number[]
  transformMode: TransformMode
  pivotMode: PivotMode
  past: HistoryEntry[]
  future: HistoryEntry[]
  nodes: SavedNodeRecord[]
  deletedRoots?: { id: number; parentId: number; index: number }[]
  savedAt: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      const db = req.result
      if (e.oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME)
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveSessionToDB(session: Omit<SavedSession, 'id'>): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const record: SavedSession = {
      ...session,
      id: SESSION_KEY,
    }
    store.put(record)
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.error('Failed to save session to IndexedDB:', err)
  }
}

export async function loadSessionFromDB(): Promise<SavedSession | null> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(SESSION_KEY)
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const result = req.result as SavedSession | undefined
        if (result && result.version === 2) {
          resolve(result)
        } else {
          resolve(null)
        }
      }
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.error('Failed to load session from IndexedDB:', err)
    return null
  }
}

export async function clearSessionFromDB(): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(SESSION_KEY)
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    console.error('Failed to clear session from IndexedDB:', err)
  }
}

export function serializeSession(params: {
  fileName: string
  fileBlob: Blob
  sceneRoot: THREE.Group
  selectedUuids: string[]
  transformMode: TransformMode
  pivotMode: PivotMode
  past: HistoryEntry[]
  future: HistoryEntry[]
}): Omit<SavedSession, 'id'> {
  const { fileName, fileBlob, sceneRoot, selectedUuids, transformMode, pivotMode, past, future } = params

  const nodes: SavedNodeRecord[] = []
  const registeredEntries = getAllRegisteredEntries()
  for (const [id, node] of registeredEntries) {
    nodes.push({
      id,
      name: node.name,
      snapshot: getObjectSnapshot(node),
      visible: node.visible,
    })
  }

  const selectedIds: number[] = []
  for (const uuid of selectedUuids) {
    const obj = sceneRoot.uuid === uuid ? sceneRoot : sceneRoot.getObjectByProperty('uuid', uuid)
    if (obj) {
      const id = getNodeId(obj)
      if (id !== undefined) {
        selectedIds.push(id)
      }
    }
  }

  return {
    version: 2,
    fileName,
    fileBlob,
    selectedIds,
    transformMode,
    pivotMode,
    past,
    future,
    nodes,
    savedAt: Date.now(),
  }
}

export function deserializeSessionState(
  sceneRoot: THREE.Group,
  session: SavedSession
): {
  selectedUuids: string[]
  past: HistoryEntry[]
  future: HistoryEntry[]
} {
  for (const item of session.nodes) {
    const node = getNodeById(item.id)
    if (node) {
      applySnapshot(node, item.snapshot)
      node.visible = item.visible
      if (node.name !== item.name) {
        node.name = item.name
        if (node.userData && typeof node.userData === 'object' && 'name' in node.userData) {
          node.userData.name = item.name
        }
      }
    }
  }

  if (session.deletedRoots) {
    for (const item of session.deletedRoots) {
      const node = getNodeById(item.id)
      if (node && node.parent) {
        node.parent.remove(node)
      }
    }
  }

  sceneRoot.updateMatrixWorld(true)

  const selectedUuids: string[] = []
  for (const id of session.selectedIds) {
    const node = getNodeById(id)
    if (node) {
      selectedUuids.push(node.uuid)
    }
  }

  return {
    selectedUuids,
    past: session.past,
    future: session.future,
  }
}
