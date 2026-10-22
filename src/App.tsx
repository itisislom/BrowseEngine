import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { useEditorStore, detectSkeletons } from './store/useEditorStore'
import { disposeHierarchy, revokeBlobUrl } from './utils/dispose'
import { flyState } from './utils/flyState'
import { initNodeRegistry, getNodeId } from './utils/nodeRegistry'
import {
  saveSessionToDB,
  loadSessionFromDB,
  serializeSession,
  deserializeSessionState,
} from './utils/sessionStorage'
import { TopBar } from './components/TopBar'
import { SceneTree } from './components/SceneTree'
import { Viewport } from './components/Viewport'
import { Inspector } from './components/Inspector'

const DEFAULT_OUTLINER_WIDTH = 260
const DEFAULT_INSPECTOR_WIDTH = 290

if (import.meta.env.DEV) {
  import('./utils/exportVerifier')
}

export default function App() {
  const modelUrl = useEditorStore((state) => state.modelUrl)
  const fileName = useEditorStore((state) => state.fileName)
  const fileBlob = useEditorStore((state) => state.fileBlob)
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const transformMode = useEditorStore((state) => state.transformMode)
  const pivotMode = useEditorStore((state) => state.pivotMode)
  const transformVersion = useEditorStore((state) => state.transformVersion)
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const past = useEditorStore((state) => state.past)
  const future = useEditorStore((state) => state.future)
  const setModel = useEditorStore((state) => state.setModel)
  const restoreSession = useEditorStore((state) => state.restoreSession)
  const setEditingNodeId = useEditorStore((state) => state.setEditingNodeId)
  const deleteNodes = useEditorStore((state) => state.deleteNodes)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)

  const isRestoringRef = useRef(false)
  const autoSaveTimerRef = useRef<number | null>(null)

  const [outlinerWidth, setOutlinerWidth] = useState<number>(() => {
    const saved = localStorage.getItem('browse_engine_outliner_width')
    if (saved) {
      const val = parseInt(saved, 10)
      if (!isNaN(val) && val >= 180) return val
    }
    return DEFAULT_OUTLINER_WIDTH
  })

  const [inspectorWidth, setInspectorWidth] = useState<number>(() => {
    const saved = localStorage.getItem('browse_engine_inspector_width')
    if (saved) {
      const val = parseInt(saved, 10)
      if (!isNaN(val) && val >= 180) return val
    }
    return DEFAULT_INSPECTOR_WIDTH
  })

  const outlinerWrapperRef = useRef<HTMLDivElement>(null)
  const inspectorWrapperRef = useRef<HTMLDivElement>(null)
  const currentOutlinerWidthRef = useRef<number>(outlinerWidth)
  const currentInspectorWidthRef = useRef<number>(inspectorWidth)

  const handleLeftResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = currentOutlinerWidthRef.current
    document.body.classList.add('resizing-panels')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const maxW = window.innerWidth * 0.5
      const newW = Math.max(180, Math.min(maxW, startW + delta))
      currentOutlinerWidthRef.current = newW
      if (outlinerWrapperRef.current) {
        outlinerWrapperRef.current.style.width = `${newW}px`
      }
    }

    const onMouseUp = () => {
      document.body.classList.remove('resizing-panels')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      setOutlinerWidth(currentOutlinerWidthRef.current)
      localStorage.setItem('browse_engine_outliner_width', String(Math.round(currentOutlinerWidthRef.current)))
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleRightResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = currentInspectorWidthRef.current
    document.body.classList.add('resizing-panels')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      const maxW = window.innerWidth * 0.5
      const newW = Math.max(180, Math.min(maxW, startW + delta))
      currentInspectorWidthRef.current = newW
      if (inspectorWrapperRef.current) {
        inspectorWrapperRef.current.style.width = `${newW}px`
      }
    }

    const onMouseUp = () => {
      document.body.classList.remove('resizing-panels')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      setInspectorWidth(currentInspectorWidthRef.current)
      localStorage.setItem('browse_engine_inspector_width', String(Math.round(currentInspectorWidthRef.current)))
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleLeftReset = () => {
    currentOutlinerWidthRef.current = DEFAULT_OUTLINER_WIDTH
    if (outlinerWrapperRef.current) {
      outlinerWrapperRef.current.style.width = `${DEFAULT_OUTLINER_WIDTH}px`
    }
    setOutlinerWidth(DEFAULT_OUTLINER_WIDTH)
    localStorage.setItem('browse_engine_outliner_width', String(DEFAULT_OUTLINER_WIDTH))
  }

  const handleRightReset = () => {
    currentInspectorWidthRef.current = DEFAULT_INSPECTOR_WIDTH
    if (inspectorWrapperRef.current) {
      inspectorWrapperRef.current.style.width = `${DEFAULT_INSPECTOR_WIDTH}px`
    }
    setInspectorWidth(DEFAULT_INSPECTOR_WIDTH)
    localStorage.setItem('browse_engine_inspector_width', String(DEFAULT_INSPECTOR_WIDTH))
  }

  // 1. Session Restoration on Initial Mount
  useEffect(() => {
    let isCancelled = false

    const restore = async () => {
      const saved = await loadSessionFromDB()
      if (!saved || isCancelled) return

      isRestoringRef.current = true
      const objectUrl = URL.createObjectURL(saved.fileBlob)
      const dracoLoader = new DRACOLoader()
      dracoLoader.setDecoderPath('/draco/gltf/')

      const loader = new GLTFLoader()
      loader.setDRACOLoader(dracoLoader)

      loader.load(
        objectUrl,
        (gltf) => {
          if (isCancelled) {
            revokeBlobUrl(objectUrl)
            dracoLoader.dispose()
            return
          }

          initNodeRegistry(gltf.scene)
          const { initialTransforms } = detectSkeletons(gltf.scene)
          const { selectedUuids, past, future } = deserializeSessionState(gltf.scene, saved)

          restoreSession({
            modelUrl: objectUrl,
            fileName: saved.fileName,
            sceneRoot: gltf.scene,
            fileBlob: saved.fileBlob,
            selectedUuids,
            transformMode: saved.transformMode,
            pivotMode: saved.pivotMode,
            past,
            future,
            initialBoneTransforms: initialTransforms,
            animationClipsCount: gltf.animations ? gltf.animations.length : 0,
          })

          dracoLoader.dispose()
          setTimeout(() => {
            isRestoringRef.current = false
          }, 100)
        },
        undefined,
        (error) => {
          console.error('Failed to restore session from IndexedDB:', error)
          revokeBlobUrl(objectUrl)
          dracoLoader.dispose()
          isRestoringRef.current = false
        }
      )
    }

    restore()

    return () => {
      isCancelled = true
    }
  }, [restoreSession])

  // 2. Auto-save session to IndexedDB on changes
  useEffect(() => {
    if (isRestoringRef.current || !sceneRoot || !fileBlob || !fileName) {
      return
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      const serialized = serializeSession({
        fileName,
        fileBlob,
        sceneRoot,
        selectedUuids,
        transformMode,
        pivotMode,
        past,
        future,
      })
      saveSessionToDB(serialized)
    }, 400)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [
    fileName,
    fileBlob,
    sceneRoot,
    selectedUuids,
    transformMode,
    pivotMode,
    transformVersion,
    structureVersion,
    past.length,
    future.length,
  ])

  // 3. BeforeUnload Confirmation Dialog and Emergency Save
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!sceneRoot || !fileBlob || !fileName) {
        return
      }

      // Immediately save state before closing/refreshing
      const serialized = serializeSession({
        fileName,
        fileBlob,
        sceneRoot,
        selectedUuids,
        transformMode,
        pivotMode,
        past,
        future,
      })
      saveSessionToDB(serialized)

      // Prompt standard confirmation dialog (F5, Ctrl+R, Tab close)
      e.preventDefault()
      e.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [fileName, fileBlob, sceneRoot, selectedUuids, transformMode, pivotMode, past, future])

  // Keyboard undo/redo and shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (flyState.active) return
      if (document.querySelector('.modal-backdrop') !== null) return

      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return
      }

      if (e.code === 'F2') {
        if (selectedUuids.length > 0 && sceneRoot) {
          e.preventDefault()
          const lastUuid = selectedUuids[selectedUuids.length - 1]
          const obj =
            sceneRoot.uuid === lastUuid
              ? sceneRoot
              : sceneRoot.getObjectByProperty('uuid', lastUuid)
          if (obj) {
            const id = getNodeId(obj)
            if (id !== undefined) {
              setEditingNodeId(id)
            }
          }
        }
        return
      }

      if (e.code === 'Delete' || (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyX')) {
        if (selectedUuids.length > 0 && sceneRoot) {
          e.preventDefault()
          deleteNodes()
        }
        return
      }

      if (!e.ctrlKey && !e.metaKey) return

      if (e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) {
          redo()
        } else {
          undo()
        }
      } else if (e.code === 'KeyY') {
        e.preventDefault()
        redo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo, deleteNodes, selectedUuids, sceneRoot, setEditingNodeId])

  // Drag and drop GLB/GLTF
  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (!file) return

      const lower = file.name.toLowerCase()
      if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
        return
      }

      disposeHierarchy(sceneRoot)
      revokeBlobUrl(modelUrl)

      const objectUrl = URL.createObjectURL(file)
      const dracoLoader = new DRACOLoader()
      dracoLoader.setDecoderPath('/draco/gltf/')

      const loader = new GLTFLoader()
      loader.setDRACOLoader(dracoLoader)

      loader.load(
        objectUrl,
        (gltf) => {
          setModel(
            objectUrl,
            file.name,
            gltf.scene,
            file,
            gltf.animations ? gltf.animations.length : 0
          )
          dracoLoader.dispose()
        },
        undefined,
        (error) => {
          revokeBlobUrl(objectUrl)
          console.error('Failed to load dropped GLB:', error)
          dracoLoader.dispose()
        }
      )
    },
    [modelUrl, sceneRoot, setModel]
  )

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }

  return (
    <div className="editor-shell" onDrop={handleDrop} onDragOver={handleDragOver}>
      <TopBar />
      <main className="editor-workspace">
        <div
          ref={outlinerWrapperRef}
          style={{ width: `${outlinerWidth}px`, flexShrink: 0, height: '100%', display: 'flex' }}
        >
          <SceneTree />
        </div>
        <div
          className="panel-splitter left-splitter"
          onMouseDown={handleLeftResizeStart}
          onDoubleClick={handleLeftReset}
          title="Drag to resize Outliner, double-click to reset"
        />
        <Viewport />
        <div
          className="panel-splitter right-splitter"
          onMouseDown={handleRightResizeStart}
          onDoubleClick={handleRightReset}
          title="Drag to resize Inspector, double-click to reset"
        />
        <div
          ref={inspectorWrapperRef}
          style={{ width: `${inspectorWidth}px`, flexShrink: 0, height: '100%', display: 'flex' }}
        >
          <Inspector />
        </div>
      </main>
    </div>
  )
}
