import { useState, useEffect, useRef, useMemo } from 'react'
import type * as THREE from 'three'
import { useEditorStore } from '../store/useEditorStore'
import { getNodeId } from '../utils/nodeRegistry'

function getNodeTypeBadge(obj: THREE.Object3D): string {
  if ('isMesh' in obj && obj.isMesh) return 'Mesh'
  if ('isBone' in obj && obj.isBone) return 'Bone'
  if ('isLight' in obj && obj.isLight) return 'Light'
  if ('isCamera' in obj && obj.isCamera) return 'Cam'
  if (obj.children.length > 0) return 'Group'
  return 'Object'
}

export function formatNodeName(node: THREE.Object3D, indexInParent: number): string {
  const raw = node.name || ''
  if (!raw || raw.includes('\uFFFD')) {
    const badge = getNodeTypeBadge(node)
    return `${badge}_${indexInParent + 1}`
  }
  return raw
}

function getVisibleChildren(node: THREE.Object3D, showBones: boolean): THREE.Object3D[] {
  if (!node.children || node.children.length === 0) return []
  if (showBones) {
    return node.children
  }

  const result: THREE.Object3D[] = []
  function collectNonBoneChildren(curr: THREE.Object3D) {
    for (const child of curr.children) {
      const isBone = (child as any).isBone || child.type === 'Bone'
      if (isBone) {
        collectNonBoneChildren(child)
      } else {
        result.push(child)
      }
    }
  }

  for (const child of node.children) {
    const isBone = (child as any).isBone || child.type === 'Bone'
    if (isBone) {
      collectNonBoneChildren(child)
    } else {
      result.push(child)
    }
  }

  return result
}

interface SceneTreeNodeProps {
  node: THREE.Object3D
  depth: number
  indexInParent: number
  isRoot?: boolean
  showBones: boolean
  selectedUuids: string[]
  expandedUuids: Set<string>
  onToggleExpand: (uuid: string) => void
  onSelect: (uuid: string) => void
  onToggleSelect: (uuid: string) => void
  onContextMenu: (
    e: React.MouseEvent,
    node: THREE.Object3D,
    isRoot: boolean,
    nodeId?: number
  ) => void
  searchFilter: string
}

function SceneTreeNode({
  node,
  depth,
  indexInParent,
  isRoot = false,
  showBones,
  selectedUuids,
  expandedUuids,
  onToggleExpand,
  onSelect,
  onToggleSelect,
  onContextMenu,
  searchFilter,
}: SceneTreeNodeProps) {
  const itemRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isSelected = selectedUuids.includes(node.uuid)
  const isExpanded = expandedUuids.has(node.uuid)
  const badge = getNodeTypeBadge(node)
  const isBone = badge === 'Bone'

  const editingNodeId = useEditorStore((state) => state.editingNodeId)
  const setEditingNodeId = useEditorStore((state) => state.setEditingNodeId)
  const renameNode = useEditorStore((state) => state.renameNode)
  const deleteNodes = useEditorStore((state) => state.deleteNodes)

  const nodeId = getNodeId(node)
  const isEditing = nodeId !== undefined && editingNodeId === nodeId

  const displayName = formatNodeName(node, indexInParent)
  const rawTitle = node.name ? `${node.name} (${badge})` : `${displayName} (${badge})`

  const [tempName, setTempName] = useState(displayName)

  useEffect(() => {
    if (isEditing) {
      setTempName(displayName)
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        }
      })
    }
  }, [isEditing, displayName])

  if (!showBones && isBone) {
    return null
  }

  const visibleChildren = getVisibleChildren(node, showBones)
  const hasChildren = visibleChildren.length > 0

  useEffect(() => {
    if (isSelected && itemRef.current) {
      itemRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
  }, [isSelected])

  const matchesSearch =
    searchFilter.length > 0 &&
    (displayName.toLowerCase().includes(searchFilter) ||
      (node.name && node.name.toLowerCase().includes(searchFilter)))

  const handleCommit = () => {
    if (nodeId !== undefined) {
      renameNode(nodeId, tempName)
    } else {
      setEditingNodeId(null)
    }
  }

  const handleCancel = () => {
    setEditingNodeId(null)
  }

  return (
    <div className="scene-tree-item-wrapper">
      <div
        ref={itemRef}
        className={`scene-tree-item ${isSelected ? 'selected' : ''} ${matchesSearch ? 'search-match' : ''}`}
        style={{ paddingLeft: `${depth * 11 + 6}px` }}
        onClick={(e) => {
          e.stopPropagation()
          if (e.altKey) {
            onToggleSelect(node.uuid)
          } else {
            onSelect(node.uuid)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!selectedUuids.includes(node.uuid)) {
            onSelect(node.uuid)
          }
          onContextMenu(e, node, isRoot, nodeId)
        }}
      >
        {hasChildren ? (
          <span
            className="collapse-toggle"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(node.uuid)
            }}
          >
            {isExpanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="collapse-placeholder" />
        )}

        <input
          type="checkbox"
          className="tree-checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation()
            onToggleSelect(node.uuid)
          }}
          onClick={(e) => e.stopPropagation()}
        />

        <span className={`node-badge badge-${badge.toLowerCase()}`}>{badge}</span>
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="tree-rename-input"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                handleCommit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancel()
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onBlur={handleCommit}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="node-name"
            title={rawTitle}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (nodeId !== undefined) {
                setEditingNodeId(nodeId)
              }
            }}
          >
            {displayName}
          </span>
        )}

        {!isRoot && (
          <button
            type="button"
            className="tree-trash-btn"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              deleteNodes([node.uuid])
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div className="scene-tree-children">
          {visibleChildren.map((child, idx) => (
            <SceneTreeNode
              key={child.uuid}
              node={child}
              depth={depth + 1}
              indexInParent={idx}
              isRoot={false}
              showBones={showBones}
              selectedUuids={selectedUuids}
              expandedUuids={expandedUuids}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onToggleSelect={onToggleSelect}
              onContextMenu={onContextMenu}
              searchFilter={searchFilter}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface ContextMenuState {
  x: number
  y: number
  node: THREE.Object3D
  nodeId?: number
  isRoot: boolean
}

export function SceneTree() {
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const showBones = useEditorStore((state) => state.showBones)
  const selectedUuids = useEditorStore((state) => state.selectedUuids)
  const selectSingle = useEditorStore((state) => state.selectSingle)
  const toggleSelection = useEditorStore((state) => state.toggleSelection)
  const structureVersion = useEditorStore((state) => state.structureVersion)
  const setEditingNodeId = useEditorStore((state) => state.setEditingNodeId)
  const deleteNodes = useEditorStore((state) => state.deleteNodes)

  const [searchFilter, setSearchFilter] = useState('')
  const [expandedUuids, setExpandedUuids] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return

    const handlePointerDown = (e: PointerEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    const handleScroll = () => {
      setContextMenu(null)
    }

    const handleResize = () => {
      setContextMenu(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
  }, [contextMenu])

  const handleContextMenu = (
    e: React.MouseEvent,
    node: THREE.Object3D,
    isRoot: boolean,
    nodeId?: number
  ) => {
    const menuWidth = 140
    const menuHeight = 70
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 4)
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 4)
    setContextMenu({
      x,
      y,
      node,
      isRoot,
      nodeId,
    })
  }

  useEffect(() => {
    if (!sceneRoot) {
      setExpandedUuids(new Set())
      return
    }

    const initial = new Set<string>()
    initial.add(sceneRoot.uuid)

    sceneRoot.traverse((node) => {
      const isBone = (node as any).isBone || node.type === 'Bone'
      if (!isBone && node.children.length > 0) {
        initial.add(node.uuid)
      }
    })

    setExpandedUuids(initial)
  }, [sceneRoot])

  useEffect(() => {
    if (!sceneRoot || selectedUuids.length === 0) return

    setExpandedUuids((prev) => {
      const next = new Set(prev)
      let changed = false

      for (const uuid of selectedUuids) {
        const obj =
          sceneRoot.uuid === uuid
            ? sceneRoot
            : sceneRoot.getObjectByProperty('uuid', uuid)
        if (obj) {
          let curr = obj.parent
          while (curr && curr !== sceneRoot.parent) {
            if (!next.has(curr.uuid)) {
              next.add(curr.uuid)
              changed = true
            }
            curr = curr.parent
          }
        }
      }

      return changed ? next : prev
    })
  }, [selectedUuids, sceneRoot])

  useEffect(() => {
    if (!sceneRoot || !searchFilter.trim()) return
    const query = searchFilter.toLowerCase().trim()

    setExpandedUuids((prev) => {
      const next = new Set(prev)
      let changed = false

      sceneRoot.traverse((node) => {
        const name = (node.name || '').toLowerCase()
        const display = formatNodeName(node, 0).toLowerCase()
        if (name.includes(query) || display.includes(query)) {
          let curr = node.parent
          while (curr && curr !== sceneRoot.parent) {
            if (!next.has(curr.uuid)) {
              next.add(curr.uuid)
              changed = true
            }
            curr = curr.parent
          }
        }
      })

      return changed ? next : prev
    })
  }, [searchFilter, sceneRoot, structureVersion])

  const handleToggleExpand = (uuid: string) => {
    setExpandedUuids((prev) => {
      const next = new Set(prev)
      if (next.has(uuid)) {
        next.delete(uuid)
      } else {
        next.add(uuid)
      }
      return next
    })
  }

  const queryClean = useMemo(() => searchFilter.toLowerCase().trim(), [searchFilter])

  return (
    <aside className="scene-tree-panel">
      <div className="panel-header">
        <span className="panel-title">Outliner</span>
      </div>

      <div className="tree-search-bar">
        <input
          type="text"
          className="tree-search-input"
          placeholder="Filter by name..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
        />
        {searchFilter && (
          <button
            type="button"
            className="tree-search-clear"
            onClick={() => setSearchFilter('')}
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="panel-content tree-scroll-content">
        {!sceneRoot ? (
          <div className="empty-message">No model loaded</div>
        ) : (
          <SceneTreeNode
            key={`${sceneRoot.uuid}_${structureVersion}`}
            node={sceneRoot}
            depth={0}
            indexInParent={0}
            isRoot={true}
            showBones={showBones}
            selectedUuids={selectedUuids}
            expandedUuids={expandedUuids}
            onToggleExpand={handleToggleExpand}
            onSelect={(uuid) => selectSingle(uuid)}
            onToggleSelect={(uuid) => toggleSelection(uuid)}
            onContextMenu={handleContextMenu}
            searchFilter={queryClean}
          />
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="tree-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              if (contextMenu.nodeId !== undefined) {
                setEditingNodeId(contextMenu.nodeId)
              }
              setContextMenu(null)
            }}
          >
            <span>Rename</span>
            <span className="context-menu-shortcut">F2</span>
          </div>
          <div
            className={`context-menu-item ${contextMenu.isRoot ? 'disabled' : ''}`}
            onClick={() => {
              if (!contextMenu.isRoot) {
                deleteNodes()
              }
              setContextMenu(null)
            }}
          >
            <span>Delete</span>
            <span className="context-menu-shortcut">Del</span>
          </div>
        </div>
      )}
    </aside>
  )
}
