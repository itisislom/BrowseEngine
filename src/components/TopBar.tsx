import { useRef, useState, useEffect, type ChangeEvent } from 'react'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { useEditorStore } from '../store/useEditorStore'
import { disposeHierarchy, revokeBlobUrl } from '../utils/dispose'
import { exportSceneToGLB } from '../utils/exportGLB'
import { clearSessionFromDB } from '../utils/sessionStorage'

export function TopBar() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [showClearModal, setShowClearModal] = useState(false)

  const animationClipsCount = useEditorStore((state) => state.animationClipsCount)
  const statusMessage = useEditorStore((state) => state.statusMessage)
  const setStatusMessage = useEditorStore((state) => state.setStatusMessage)
  const modelUrl = useEditorStore((state) => state.modelUrl)
  const fileName = useEditorStore((state) => state.fileName)
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const setModel = useEditorStore((state) => state.setModel)
  const reset = useEditorStore((state) => state.reset)
  const past = useEditorStore((state) => state.past)
  const future = useEditorStore((state) => state.future)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)

  useEffect(() => {
    if (!showClearModal) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowClearModal(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showClearModal])

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    disposeHierarchy(sceneRoot)
    revokeBlobUrl(modelUrl)

    setLoading(true)
    setStatusMessage('Loading model...')

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
        setLoading(false)
        setStatusMessage(null)
        dracoLoader.dispose()
      },
      undefined,
      (error) => {
        revokeBlobUrl(objectUrl)
        setLoading(false)
        setStatusMessage('Error loading GLB file')
        console.error('Failed to load GLTF/GLB model:', error)
        dracoLoader.dispose()
      }
    )

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleExport = async () => {
    if (!sceneRoot) return
    try {
      setStatusMessage('Exporting GLB...')
      const targetName = fileName ? `edited_${fileName}` : 'edited_model.glb'
      await exportSceneToGLB(sceneRoot, targetName)
      if (animationClipsCount > 0) {
        setStatusMessage(
          `Warning: original animations (${animationClipsCount}) are not exported`
        )
      } else {
        setStatusMessage(null)
      }
    } catch (err) {
      console.error('Failed to export GLB:', err)
      setStatusMessage('Export failed')
    }
  }

  const handleClear = () => {
    disposeHierarchy(sceneRoot)
    revokeBlobUrl(modelUrl)
    clearSessionFromDB()
    reset()
    setStatusMessage(null)
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <span className="app-logo">BrowseEngine</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,.gltf"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="topbar-btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            {loading ? 'Opening...' : 'Open GLB'}
          </button>

          <button
            type="button"
            className="topbar-btn"
            onClick={handleExport}
            disabled={!sceneRoot || loading}
            title="Export to GLB (hidden objects are not exported)"
          >
            Export GLB
          </button>

          <button
            type="button"
            className="topbar-btn"
            onClick={undo}
            disabled={past.length === 0 || loading}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>

          <button
            type="button"
            className="topbar-btn"
            onClick={redo}
            disabled={future.length === 0 || loading}
            title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
          >
            Redo
          </button>

          {sceneRoot && (
            <button
              type="button"
              className="topbar-btn danger"
              onClick={() => setShowClearModal(true)}
              disabled={loading}
            >
              Clear
            </button>
          )}
        </div>

        <div className="topbar-center">
          {fileName ? (
            <span className="file-info" title={fileName}>
              File: <strong>{fileName}</strong>
            </span>
          ) : (
            <span className="file-info muted">No file open</span>
          )}
          {statusMessage && <span className="status-badge">{statusMessage}</span>}
        </div>

        <div className="topbar-right" />
      </header>

      {showClearModal && (
        <div className="modal-backdrop" onClick={() => setShowClearModal(false)}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Clear Scene</div>
            <p className="modal-message">Are you sure you want to clear the scene?</p>
            <div className="modal-actions">
              <button
                type="button"
                className="topbar-btn danger"
                onClick={() => {
                  handleClear()
                  setShowClearModal(false)
                }}
              >
                Yes
              </button>
              <button
                type="button"
                className="topbar-btn"
                onClick={() => setShowClearModal(false)}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
