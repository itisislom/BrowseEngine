import { useEditorStore } from '../store/useEditorStore'

export function FlyCrosshair() {
  const isFlying = useEditorStore((state) => state.isFlying)

  if (!isFlying) {
    return null
  }

  return (
    <div className="fly-crosshair" aria-hidden="true">
      <div className="fly-crosshair-h" />
      <div className="fly-crosshair-v" />
    </div>
  )
}
