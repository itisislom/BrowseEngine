import { useState, useRef, useEffect, type PointerEvent, type KeyboardEvent } from 'react'

interface ScrubInputProps {
  label: string
  labelClass: 'x' | 'y' | 'z'
  value: number
  step: number
  decimals?: number
  defaultValue: number
  disabled?: boolean
  onStartDrag: () => void
  onDrag: (newValue: number) => void
  onEndDrag: (hasChanged: boolean) => void
  onCommitDirectValue: (newValue: number) => void
  onReset: () => void
}

export function ScrubInput({
  label,
  labelClass,
  value,
  step,
  decimals = 3,
  defaultValue,
  disabled = false,
  onStartDrag,
  onDrag,
  onEndDrag,
  onCommitDirectValue,
  onReset,
}: ScrubInputProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [textValue, setTextValue] = useState(value.toFixed(decimals))

  const inputRef = useRef<HTMLInputElement>(null)
  const isPointerDownRef = useRef(false)
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startValueRef = useRef(value)
  const dragStartedNotifiedRef = useRef(false)

  useEffect(() => {
    if (!isEditing) {
      setTextValue(value.toFixed(decimals))
    }
  }, [value, decimals, isEditing])

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || isEditing) return
    if (e.button !== 0) return

    isPointerDownRef.current = true
    isDraggingRef.current = false
    dragStartedNotifiedRef.current = false
    startXRef.current = e.clientX
    startValueRef.current = value

    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current) return

    const deltaX = e.clientX - startXRef.current

    if (!isDraggingRef.current && Math.abs(deltaX) > 3) {
      isDraggingRef.current = true
      if (!dragStartedNotifiedRef.current) {
        dragStartedNotifiedRef.current = true
        onStartDrag()
      }
    }

    if (isDraggingRef.current) {
      let multiplier = 1.0
      if (e.shiftKey) {
        multiplier = 0.1
      } else if (e.ctrlKey || e.altKey) {
        multiplier = 5.0
      }

      const nextValue = startValueRef.current + deltaX * step * multiplier
      onDrag(nextValue)
    }
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current) return
    isPointerDownRef.current = false

    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Ignored if capture already lost
    }

    if (isDraggingRef.current) {
      const hasChanged = startValueRef.current !== value
      onEndDrag(hasChanged)
      isDraggingRef.current = false
      dragStartedNotifiedRef.current = false
    } else {
      setIsEditing(true)
      setTextValue(value.toFixed(decimals))
    }
  }

  const commitText = () => {
    const parsed = parseFloat(textValue)
    if (!Number.isNaN(parsed) && parsed !== value) {
      onCommitDirectValue(parsed)
    } else {
      setTextValue(value.toFixed(decimals))
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitText()
    } else if (e.key === 'Escape') {
      setTextValue(value.toFixed(decimals))
      setIsEditing(false)
    }
  }

  return (
    <div
      className={`scrub-input ${isEditing ? 'editing' : ''} ${disabled ? 'disabled' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <span
        className={`scrub-badge ${labelClass}`}
        title={`Double-click to reset (default: ${defaultValue})`}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (!disabled) onReset()
        }}
      >
        {label}
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          type="number"
          step={step}
          className="scrub-native-input"
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitText}
        />
      ) : (
        <span className="scrub-value-display">
          {value.toFixed(decimals)}
        </span>
      )}
    </div>
  )
}
