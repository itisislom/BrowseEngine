import { useMemo, useRef, useState, useEffect } from 'react'
import type * as THREE from 'three'
import {
  useEditorStore,
  getObjectSnapshot,
  areSnapshotsEqual,
  type TransformSnapshot,
  type PropertyChange,
} from '../store/useEditorStore'
import { ScrubInput } from './ScrubInput'
import { flyState } from '../utils/flyState'
import { getNodeId } from '../utils/nodeRegistry'
import { formatNodeName } from './SceneTree'

const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180

export function findArmatureAncestor(mesh: THREE.SkinnedMesh): THREE.Object3D | null {
  const bones = mesh.skeleton?.bones
  if (!bones || bones.length === 0) return mesh.parent

  const boneSet = new Set(bones)
  const rootBones = bones.filter((b) => !b.parent || !boneSet.has(b.parent as THREE.Bone))

  let current: THREE.Object3D | null = mesh.parent
  while (current) {
    const isAncestorOfAll = rootBones.every((bone) => {
      let bCurr: THREE.Object3D | null = bone
      while (bCurr) {
        if (bCurr === current) return true
        bCurr = bCurr.parent
      }
      return false
    })
    if (isAncestorOfAll) {
      return current
    }
    current = current.parent
  }

  return mesh.parent
}

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
  startPos: [number, number, number]
  startRot: [number, number, number]
  startScale: [number, number, number]
}

export function Inspector() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const transformVersion = useEditorStore((state) => state.transformVersion)
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const bumpTransformVersion = useEditorStore((state) => state.bumpTransformVersion)
  const pushHistory = useEditorStore((state) => state.pushHistory)
  const resetBonePose = useEditorStore((state) => state.resetBonePose)
  const renameNode = useEditorStore((state) => state.renameNode)
  const selectSingle = useEditorStore((state) => state.selectSingle)

  const selectedObjects = useMemo(() => {
    if (!sceneRoot || selectedUuids.length === 0) return []
    const list: THREE.Object3D[] = []
    for (const uuid of selectedUuids) {
      const found =
        sceneRoot.uuid === uuid
          ? sceneRoot
          : sceneRoot.getObjectByProperty('uuid', uuid)
      if (found) {
        list.push(found)
      }
    }
    return filterAncestors(list)
  }, [sceneRoot, selectedUuids])

  const dragItemsRef = useRef<DragItem[]>([])
  const dragStartScrubValRef = useRef<number>(0)

  const [posX, setPosX] = useState(0)
  const [posY, setPosY] = useState(0)
  const [posZ, setPosZ] = useState(0)

  const [rotX, setRotX] = useState(0)
  const [rotY, setRotY] = useState(0)
  const [rotZ, setRotZ] = useState(0)

  const [scaleX, setScaleX] = useState(1)
  const [scaleY, setScaleY] = useState(1)
  const [scaleZ, setScaleZ] = useState(1)

  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (selectedObjects.length === 0) return

    if (selectedObjects.length === 1) {
      const obj = selectedObjects[0]
      setPosX(obj.position.x)
      setPosY(obj.position.y)
      setPosZ(obj.position.z)

      setRotX(obj.rotation.x * RAD_TO_DEG)
      setRotY(obj.rotation.y * RAD_TO_DEG)
      setRotZ(obj.rotation.z * RAD_TO_DEG)

      setScaleX(obj.scale.x)
      setScaleY(obj.scale.y)
      setScaleZ(obj.scale.z)

      setVisible(obj.visible)
    } else {
      // Multiple selected: average values
      let sumPx = 0, sumPy = 0, sumPz = 0
      let sumRx = 0, sumRy = 0, sumRz = 0
      let sumSx = 0, sumSy = 0, sumSz = 0
      let allVisible = true

      for (const obj of selectedObjects) {
        sumPx += obj.position.x
        sumPy += obj.position.y
        sumPz += obj.position.z

        sumRx += obj.rotation.x * RAD_TO_DEG
        sumRy += obj.rotation.y * RAD_TO_DEG
        sumRz += obj.rotation.z * RAD_TO_DEG

        sumSx += obj.scale.x
        sumSy += obj.scale.y
        sumSz += obj.scale.z

        if (!obj.visible) allVisible = false
      }

      const count = selectedObjects.length
      setPosX(sumPx / count)
      setPosY(sumPy / count)
      setPosZ(sumPz / count)

      setRotX(sumRx / count)
      setRotY(sumRy / count)
      setRotZ(sumRz / count)

      setScaleX(sumSx / count)
      setScaleY(sumSy / count)
      setScaleZ(sumSz / count)

      setVisible(allVisible)
    }
  }, [selectedObjects, transformVersion])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (flyState.active) return

      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && selectedObjects.length > 0) {
        if (e.code === 'KeyR') {
          e.preventDefault()
          resetBonePose(selectedObjects.map((o) => o.uuid), 'rotation')
        } else if (e.code === 'KeyG') {
          e.preventDefault()
          resetBonePose(selectedObjects.map((o) => o.uuid), 'position')
        } else if (e.code === 'KeyS') {
          e.preventDefault()
          resetBonePose(selectedObjects.map((o) => o.uuid), 'scale')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedObjects, resetBonePose])

  const handleStartDrag = (currentScrubVal: number) => {
    if (selectedObjects.length === 0) return
    dragStartScrubValRef.current = currentScrubVal
    dragItemsRef.current = selectedObjects.map((obj) => ({
      obj,
      before: getObjectSnapshot(obj),
      startPos: [obj.position.x, obj.position.y, obj.position.z],
      startRot: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      startScale: [obj.scale.x, obj.scale.y, obj.scale.z],
    }))
  }

  const handleEndDrag = () => {
    if (dragItemsRef.current.length === 0) return

    const changes: PropertyChange[] = []
    for (const item of dragItemsRef.current) {
      item.obj.updateMatrixWorld(true)
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
      if (sceneRoot) {
        sceneRoot.updateMatrixWorld(true)
      }
      pushHistory({ type: 'transform', changes })
    }

    dragItemsRef.current = []
    bumpTransformVersion()
  }

  const handleDragPos = (axisIndex: 0 | 1 | 2, newVal: number) => {
    const delta = newVal - dragStartScrubValRef.current
    for (const item of dragItemsRef.current) {
      const prop = axisIndex === 0 ? 'x' : axisIndex === 1 ? 'y' : 'z'
      item.obj.position[prop] = item.startPos[axisIndex] + delta
      item.obj.updateMatrixWorld(true)
    }
    if (sceneRoot) {
      sceneRoot.updateMatrixWorld(true)
    }
    if (axisIndex === 0) setPosX(newVal)
    if (axisIndex === 1) setPosY(newVal)
    if (axisIndex === 2) setPosZ(newVal)
  }

  const handleDragRot = (axisIndex: 0 | 1 | 2, newValDeg: number) => {
    const deltaRad = (newValDeg - dragStartScrubValRef.current) * DEG_TO_RAD
    for (const item of dragItemsRef.current) {
      const prop = axisIndex === 0 ? 'x' : axisIndex === 1 ? 'y' : 'z'
      item.obj.rotation[prop] = item.startRot[axisIndex] + deltaRad
      item.obj.quaternion.setFromEuler(item.obj.rotation)
      item.obj.updateMatrixWorld(true)
    }
    if (sceneRoot) {
      sceneRoot.updateMatrixWorld(true)
    }
    if (axisIndex === 0) setRotX(newValDeg)
    if (axisIndex === 1) setRotY(newValDeg)
    if (axisIndex === 2) setRotZ(newValDeg)
  }

  const handleDragScale = (axisIndex: 0 | 1 | 2, newVal: number) => {
    const delta = newVal - dragStartScrubValRef.current
    for (const item of dragItemsRef.current) {
      const prop = axisIndex === 0 ? 'x' : axisIndex === 1 ? 'y' : 'z'
      item.obj.scale[prop] = Math.max(0.001, item.startScale[axisIndex] + delta)
      item.obj.updateMatrixWorld(true)
    }
    if (sceneRoot) {
      sceneRoot.updateMatrixWorld(true)
    }
    if (axisIndex === 0) setScaleX(newVal)
    if (axisIndex === 1) setScaleY(newVal)
    if (axisIndex === 2) setScaleZ(newVal)
  }

  const commitDirectChange = (applyFn: () => void) => {
    if (selectedObjects.length === 0) return

    const befores = selectedObjects.map((obj) => ({
      obj,
      before: getObjectSnapshot(obj),
    }))

    applyFn()

    const changes: PropertyChange[] = []
    for (const item of befores) {
      item.obj.quaternion.setFromEuler(item.obj.rotation)
      item.obj.updateMatrixWorld(true)
      const after = getObjectSnapshot(item.obj)
      if (!areSnapshotsEqual(item.before, after)) {
        changes.push({
          id: getNodeId(item.obj),
          uuid: item.obj.uuid,
          before: item.before,
          after,
        })
      }
    }

    if (sceneRoot) {
      sceneRoot.updateMatrixWorld(true)
    }

    if (changes.length > 0) {
      pushHistory({ type: 'transform', changes })
    }
    bumpTransformVersion()
  }

  const toggleVisible = () => {
    if (selectedObjects.length === 0) return
    const nextVal = !visible
    commitDirectChange(() => {
      for (const obj of selectedObjects) {
        obj.visible = nextVal
      }
      setVisible(nextVal)
    })
  }

  const isMultiple = selectedObjects.length > 1
  const singleObject = selectedObjects.length === 1 ? selectedObjects[0] : null
  const isSingleBone =
    !isMultiple &&
    Boolean(
      singleObject &&
        ((singleObject as any).isBone || singleObject.type === 'Bone')
    )
  const isSingleSkinnedMesh =
    !isMultiple &&
    Boolean(
      singleObject &&
        ((singleObject as any).isSkinnedMesh || singleObject.type === 'SkinnedMesh')
    )
  const armatureAncestor =
    isSingleSkinnedMesh ? findArmatureAncestor(singleObject as THREE.SkinnedMesh) : null

  const isTransformDisabled = Boolean(
    isSingleSkinnedMesh ||
      (isMultiple && selectedObjects.every((obj) => (obj as any).isSkinnedMesh))
  )
  const hasBoneSelected = selectedObjects.some(
    (obj) => (obj as any).isBone || obj.type === 'Bone'
  )

  const [inspectorName, setInspectorName] = useState('')

  useEffect(() => {
    if (singleObject) {
      setInspectorName(singleObject.name || '')
    } else {
      setInspectorName('')
    }
  }, [singleObject, structureVersion])

  const commitInspectorRename = () => {
    if (!singleObject) return
    const id = getNodeId(singleObject)
    if (id !== undefined) {
      renameNode(id, inspectorName)
    }
  }

  return (
    <aside className="inspector-panel">
      <div className="panel-header">
        <span className="panel-title">Inspector</span>
      </div>

      <div className="panel-content">
        {selectedObjects.length === 0 ? (
          <div className="empty-message">No object selected</div>
        ) : (
          <div className="inspector-content">
            <div className="inspector-section">
              {isMultiple ? (
                <>
                  <div className="inspector-name-row">
                    <input
                      type="text"
                      className="inspector-name-input disabled"
                      value={`Multiple (${selectedObjects.length} objects)`}
                      disabled
                      title="Name editing is disabled for multiple selection"
                    />
                  </div>
                  <div className="object-type-label">Group Selection</div>
                </>
              ) : (
                <>
                  <div className="inspector-name-row">
                    <input
                      type="text"
                      className="inspector-name-input"
                      value={inspectorName}
                      placeholder={singleObject ? formatNodeName(singleObject, 0) : 'Unnamed Object'}
                      onChange={(e) => setInspectorName(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          commitInspectorRename()
                          ;(e.target as HTMLInputElement).blur()
                        } else if (e.key === 'Escape') {
                          setInspectorName(singleObject?.name || '')
                          ;(e.target as HTMLInputElement).blur()
                        }
                      }}
                      onBlur={commitInspectorRename}
                      onKeyUp={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="object-type-label">Type: {singleObject?.type}</div>
                  {isSingleSkinnedMesh && (
                    <div className="skinned-notice-card">
                      <div className="skinned-notice-text">
                        Skinned: driven by bones
                      </div>
                      {armatureAncestor && (
                        <button
                          type="button"
                          className="inspector-bone-btn"
                          onClick={() => selectSingle(armatureAncestor.uuid)}
                          title={`Select ${armatureAncestor.name || 'Armature'}`}
                        >
                          Select Armature
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {isSingleBone && (
                <div className="bone-info-meta">
                  <div className="inspector-row-info">
                    <span className="info-key">Parent:</span>
                    <span className="info-val">{singleObject?.parent?.name || 'Root / None'}</span>
                  </div>
                  <div className="inspector-row-info">
                    <span className="info-key">Children:</span>
                    <span className="info-val">{singleObject?.children.length || 0}</span>
                  </div>
                </div>
              )}

              {hasBoneSelected && (
                <div className="bone-actions-row">
                  <button
                    type="button"
                    className="inspector-bone-btn"
                    onClick={() => resetBonePose(selectedObjects.map((o) => o.uuid))}
                    title="Reset selected bone to bind pose (Alt+R: rotation, Alt+G: position, Alt+S: scale)"
                  >
                    Reset Bone
                  </button>
                  <button
                    type="button"
                    className="inspector-bone-btn secondary"
                    onClick={() => resetBonePose()}
                    title="Reset all bones in skeleton to initial bind pose"
                  >
                    Reset Pose
                  </button>
                </div>
              )}

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={toggleVisible}
                />
                <span>Visible</span>
              </label>
            </div>

            <div className="inspector-section">
              <div className="section-title">Position</div>
              <div className="vector-row">
                <ScrubInput
                  label="X"
                  labelClass="x"
                  value={posX}
                  step={0.01}
                  decimals={3}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(posX)}
                  onDrag={(v) => handleDragPos(0, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - posX
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.x += delta
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.x = 0
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Y"
                  labelClass="y"
                  value={posY}
                  step={0.01}
                  decimals={3}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(posY)}
                  onDrag={(v) => handleDragPos(1, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - posY
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.y += delta
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.y = 0
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Z"
                  labelClass="z"
                  value={posZ}
                  step={0.01}
                  decimals={3}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(posZ)}
                  onDrag={(v) => handleDragPos(2, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - posZ
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.z += delta
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.position.z = 0
                      }
                    })
                  }
                />
              </div>
            </div>

            <div className="inspector-section">
              <div className="section-title">Rotation (deg)</div>
              <div className="vector-row">
                <ScrubInput
                  label="X"
                  labelClass="x"
                  value={rotX}
                  step={0.5}
                  decimals={1}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(rotX)}
                  onDrag={(v) => handleDragRot(0, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const deltaRad = (v - rotX) * DEG_TO_RAD
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.x += deltaRad
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.x = 0
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Y"
                  labelClass="y"
                  value={rotY}
                  step={0.5}
                  decimals={1}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(rotY)}
                  onDrag={(v) => handleDragRot(1, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const deltaRad = (v - rotY) * DEG_TO_RAD
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.y += deltaRad
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.y = 0
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Z"
                  labelClass="z"
                  value={rotZ}
                  step={0.5}
                  decimals={1}
                  defaultValue={0}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(rotZ)}
                  onDrag={(v) => handleDragRot(2, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const deltaRad = (v - rotZ) * DEG_TO_RAD
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.z += deltaRad
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.rotation.z = 0
                      }
                    })
                  }
                />
              </div>
            </div>

            <div className="inspector-section">
              <div className="section-title">Scale</div>
              <div className="vector-row">
                <ScrubInput
                  label="X"
                  labelClass="x"
                  value={scaleX}
                  step={0.01}
                  decimals={3}
                  defaultValue={1}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(scaleX)}
                  onDrag={(v) => handleDragScale(0, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - scaleX
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.x = Math.max(0.001, obj.scale.x + delta)
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.x = 1
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Y"
                  labelClass="y"
                  value={scaleY}
                  step={0.01}
                  decimals={3}
                  defaultValue={1}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(scaleY)}
                  onDrag={(v) => handleDragScale(1, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - scaleY
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.y = Math.max(0.001, obj.scale.y + delta)
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.y = 1
                      }
                    })
                  }
                />
                <ScrubInput
                  label="Z"
                  labelClass="z"
                  value={scaleZ}
                  step={0.01}
                  decimals={3}
                  defaultValue={1}
                  disabled={isTransformDisabled}
                  onStartDrag={() => handleStartDrag(scaleZ)}
                  onDrag={(v) => handleDragScale(2, v)}
                  onEndDrag={handleEndDrag}
                  onCommitDirectValue={(v) => {
                    const delta = v - scaleZ
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.z = Math.max(0.001, obj.scale.z + delta)
                      }
                    })
                  }}
                  onReset={() =>
                    commitDirectChange(() => {
                      for (const obj of selectedObjects) {
                        obj.scale.z = 1
                      }
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
