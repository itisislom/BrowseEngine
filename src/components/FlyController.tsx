import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { useEditorStore } from '../store/useEditorStore'
import { flyState } from '../utils/flyState'
import {
  flyAim,
  performRaycast,
  clearFlyPin,
  formatGodotVector3,
  copyToClipboard,
  getSanitizedObjectName,
} from '../utils/flyAim'

export const FLY_KEYS = {
  FORWARD: 'KeyW',
  BACKWARD: 'KeyS',
  LEFT: 'KeyA',
  RIGHT: 'KeyD',
  DOWN: 'KeyQ',
  UP: 'KeyE',
} as const

interface CameraSnapshot {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  target: THREE.Vector3
  distance: number
}

interface FlyControllerProps {
  controlsRef: RefObject<any>
}

let savedFlySpeed: number | null = null

export function FlyController({ controlsRef }: FlyControllerProps) {
  const { camera, gl } = useThree()
  const sceneRoot = useEditorStore((state) => state.sceneRoot)
  const isFlying = useEditorStore((state) => state.isFlying)
  const setIsFlying = useEditorStore((state) => state.setIsFlying)
  const setStatusMessage = useEditorStore((state) => state.setStatusMessage)

  const statusTimerRef = useRef<number | null>(null)
  const snapshotRef = useRef<CameraSnapshot | null>(null)
  const pitchRef = useRef(0)
  const yawRef = useRef(0)
  const flySpeedRef = useRef(2.0)
  const currentVelocity = useRef(new THREE.Vector3(0, 0, 0))

  const showFlyStatus = (msg: string) => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = null
    }
    setStatusMessage(msg)
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage(null)
      statusTimerRef.current = null
    }, 2000)
  }

  const keysPressedRef = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    down: false,
    up: false,
    fast: false,
    slow: false,
  })

  const resetKeys = () => {
    keysPressedRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      down: false,
      up: false,
      fast: false,
      slow: false,
    }
  }

  const calcSceneSpeed = (): number => {
    if (sceneRoot) {
      const box = new THREE.Box3().setFromObject(sceneRoot)
      if (!box.isEmpty()) {
        const sphere = new THREE.Sphere()
        box.getBoundingSphere(sphere)
        if (sphere.radius > 0.001) {
          return sphere.radius * 0.5
        }
      }
    }
    return 2.0
  }

  const confirmExit = () => {
    if (!flyState.active) return
    flyState.active = false
    flyState.exitedAt = Date.now()
    setIsFlying(false)
    resetKeys()
    clearFlyPin()
    showFlyStatus('Fly Mode OFF')

    if (document.pointerLockElement) {
      document.exitPointerLock()
    }

    const controls = controlsRef.current
    if (controls) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      const minDist = controls.minDistance || 0.05
      const savedDist = snapshotRef.current?.distance || 5
      const dist = Math.max(minDist, savedDist)
      controls.target.copy(camera.position).addScaledVector(forward, dist)
      controls.enabled = true
      controls.update()
    }
  }

  const cancelExit = () => {
    if (!flyState.active) return
    flyState.active = false
    flyState.exitedAt = Date.now()
    setIsFlying(false)
    resetKeys()
    clearFlyPin()
    showFlyStatus('Fly Mode OFF')

    if (document.pointerLockElement) {
      document.exitPointerLock()
    }

    const snap = snapshotRef.current
    const controls = controlsRef.current
    if (snap) {
      camera.position.copy(snap.position)
      camera.quaternion.copy(snap.quaternion)
      camera.updateMatrixWorld(true)
      if (controls) {
        controls.target.copy(snap.target)
        controls.enabled = true
        controls.update()
      }
    } else if (controls) {
      controls.enabled = true
      controls.update()
    }
  }

  const startFly = () => {
    if (flyState.active) return

    const canvas = gl.domElement
    const controls = controlsRef.current
    const target = controls?.target ? controls.target.clone() : new THREE.Vector3(0, 0, 0)
    const distance = camera.position.distanceTo(target)

    snapshotRef.current = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      target,
      distance,
    }

    // Initialize speed based on scene scale if not previously set
    const sceneSpeed = calcSceneSpeed()
    if (savedFlySpeed === null) {
      savedFlySpeed = sceneSpeed
    }
    flySpeedRef.current = savedFlySpeed

    // Initialize Euler YXZ (yaw around world Y, pitch clamped to +-89 deg)
    const euler = new THREE.Euler(0, 0, 0, 'YXZ')
    euler.setFromQuaternion(camera.quaternion, 'YXZ')
    const maxPitch = (89 * Math.PI) / 180
    euler.x = Math.max(-maxPitch, Math.min(maxPitch, euler.x))
    euler.z = 0
    pitchRef.current = euler.x
    yawRef.current = euler.y
    camera.quaternion.setFromEuler(euler)
    camera.updateMatrixWorld(true)

    // Disable OrbitControls
    if (controls) {
      controls.enabled = false
    }

    resetKeys()
    currentVelocity.current.set(0, 0, 0)

    try {
      const lockPromise = canvas.requestPointerLock()
      if (lockPromise && typeof (lockPromise as any).catch === 'function') {
        ;(lockPromise as any).catch((err: any) => {
          console.warn('Pointer lock request rejected:', err)
          setStatusMessage('Pointer lock denied')
          setTimeout(() => setStatusMessage(null), 3000)
          cancelExit()
        })
      }
    } catch (err) {
      console.warn('Pointer lock request exception:', err)
      setStatusMessage('Pointer lock denied')
      setTimeout(() => setStatusMessage(null), 3000)
      cancelExit()
      return
    }

    flyState.active = true
    setIsFlying(true)
    showFlyStatus('Fly Mode ON')
  }

  // Register start and exit actions in flyState for external callers
  useEffect(() => {
    ;(flyState as any).startFly = startFly
    ;(flyState as any).confirmExit = confirmExit
    ;(flyState as any).cancelExit = cancelExit
    return () => {
      delete (flyState as any).startFly
      delete (flyState as any).confirmExit
      delete (flyState as any).cancelExit
    }
  }, [camera, gl, sceneRoot, setIsFlying, setStatusMessage])

  // Cancel fly mode if model changes or unmounts
  useEffect(() => {
    if (flyState.active) {
      cancelExit()
    }
  }, [sceneRoot])

  useEffect(() => {
    return () => {
      if (flyState.active) {
        cancelExit()
      }
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current)
      }
    }
  }, [])

  // Pointer lock change & error listeners
  useEffect(() => {
    const canvas = gl.domElement

    const handlePointerLockChange = () => {
      if (document.pointerLockElement !== canvas) {
        if (flyState.active) {
          cancelExit()
        }
      }
    }

    const handlePointerLockError = () => {
      if (flyState.active) {
        setStatusMessage('Pointer lock denied')
        setTimeout(() => setStatusMessage(null), 3000)
        cancelExit()
      }
    }

    document.addEventListener('pointerlockchange', handlePointerLockChange)
    document.addEventListener('pointerlockerror', handlePointerLockError)

    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange)
      document.removeEventListener('pointerlockerror', handlePointerLockError)
    }
  }, [gl, setStatusMessage])

  // Global Shift + ` handler and blur / visibilitychange listeners
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && e.shiftKey) {
        const activeTag = document.activeElement?.tagName.toLowerCase()
        const isEditable = (document.activeElement as HTMLElement)?.isContentEditable
        if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || isEditable) {
          return
        }

        const modalOpen = document.querySelector('.modal-backdrop') !== null
        if (modalOpen) return

        e.preventDefault()
        e.stopPropagation()

        if (flyState.active) {
          confirmExit()
        } else {
          startFly()
        }
      }
    }

    const handleBlur = () => {
      if (flyState.active) {
        cancelExit()
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden && flyState.active) {
        cancelExit()
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [gl, sceneRoot])

  // Active fly mode input handlers (mouse move, wheel, capture keyboard, mouse clicks)
  useEffect(() => {
    if (!isFlying) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!flyState.active) return

      const MOUSE_SENSITIVITY = 0.0022
      yawRef.current -= e.movementX * MOUSE_SENSITIVITY
      pitchRef.current -= e.movementY * MOUSE_SENSITIVITY

      const maxPitch = (89 * Math.PI) / 180
      pitchRef.current = Math.max(-maxPitch, Math.min(maxPitch, pitchRef.current))

      const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, 'YXZ')
      camera.quaternion.setFromEuler(euler)
    }

    const handleWheel = (e: WheelEvent) => {
      if (!flyState.active) return
      e.preventDefault()
      e.stopPropagation()

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const sceneBase = calcSceneSpeed()
      const minSpeed = Math.max(0.001, sceneBase * 0.01)
      const maxSpeed = sceneBase * 100
      flySpeedRef.current = Math.max(minSpeed, Math.min(maxSpeed, flySpeedRef.current * factor))
      savedFlySpeed = flySpeedRef.current
    }

    const handleKeyDownCapture = (e: KeyboardEvent) => {
      if (!flyState.active) return

      if (e.code === 'AltLeft' || e.code === 'AltRight' || e.altKey) {
        e.preventDefault()
      }

      // Exit confirmations
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault()
        e.stopImmediatePropagation()
        confirmExit()
        return
      }

      if (e.code === 'Backquote' && e.shiftKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        confirmExit()
        return
      }

      // Exit cancellation
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        cancelExit()
        return
      }

      // Pin coordinate point under crosshair
      if (e.code === 'KeyC') {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()

        if (flyAim.pinnedPoint) {
          clearFlyPin()
        } else {
          const freshHit = performRaycast(camera, sceneRoot)
          if (!freshHit.hit || !freshHit.object) {
            showFlyStatus('No surface under crosshair')
          } else {
            const objName = getSanitizedObjectName(freshHit.object)
            flyAim.pinnedPoint = {
              point: freshHit.point.clone(),
              normal: freshHit.normal.clone(),
              objectName: objName,
            }
            const godotPos = formatGodotVector3(freshHit.point)
            copyToClipboard(godotPos).then((ok) => {
              showFlyStatus(ok ? 'Position copied' : 'Copy failed')
            })
          }
        }
        return
      }

      // Fly navigation keys
      if (e.code === FLY_KEYS.FORWARD) {
        keysPressedRef.current.forward = true
      } else if (e.code === FLY_KEYS.BACKWARD) {
        keysPressedRef.current.backward = true
      } else if (e.code === FLY_KEYS.LEFT) {
        keysPressedRef.current.left = true
      } else if (e.code === FLY_KEYS.RIGHT) {
        keysPressedRef.current.right = true
      } else if (e.code === FLY_KEYS.DOWN) {
        keysPressedRef.current.down = true
      } else if (e.code === FLY_KEYS.UP) {
        keysPressedRef.current.up = true
      }

      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.shiftKey) {
        keysPressedRef.current.fast = true
      }
      if (e.code === 'AltLeft' || e.code === 'AltRight' || e.altKey) {
        keysPressedRef.current.slow = true
      }

      // Stop all other shortcuts (e.g. W/E/R, B, Ctrl+Z, etc.)
      e.stopImmediatePropagation()
    }

    const handleKeyUpCapture = (e: KeyboardEvent) => {
      if (!flyState.active) return

      if (e.code === FLY_KEYS.FORWARD) {
        keysPressedRef.current.forward = false
      } else if (e.code === FLY_KEYS.BACKWARD) {
        keysPressedRef.current.backward = false
      } else if (e.code === FLY_KEYS.LEFT) {
        keysPressedRef.current.left = false
      } else if (e.code === FLY_KEYS.RIGHT) {
        keysPressedRef.current.right = false
      } else if (e.code === FLY_KEYS.DOWN) {
        keysPressedRef.current.down = false
      } else if (e.code === FLY_KEYS.UP) {
        keysPressedRef.current.up = false
      }

      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || !e.shiftKey) {
        keysPressedRef.current.fast = false
      }
      if (e.code === 'AltLeft' || e.code === 'AltRight' || !e.altKey) {
        keysPressedRef.current.slow = false
      }

      e.stopImmediatePropagation()
    }

    const handleMouseDownCapture = (e: MouseEvent) => {
      if (!flyState.active) return
      e.preventDefault()
      e.stopImmediatePropagation()

      if (e.button === 0) {
        // LMB confirms
        confirmExit()
      } else if (e.button === 2) {
        // RMB cancels
        cancelExit()
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      if (flyState.active || Date.now() - flyState.exitedAt < 150) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('keydown', handleKeyDownCapture, true)
    window.addEventListener('keyup', handleKeyUpCapture, true)
    window.addEventListener('mousedown', handleMouseDownCapture, true)
    window.addEventListener('contextmenu', handleContextMenu, true)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDownCapture, true)
      window.removeEventListener('keyup', handleKeyUpCapture, true)
      window.removeEventListener('mousedown', handleMouseDownCapture, true)
      window.removeEventListener('contextmenu', handleContextMenu, true)
    }
  }, [isFlying, gl, camera])

  // Continuous movement and direct DOM HUD speed update
  useFrame((_, delta) => {
    if (!flyState.active) {
      currentVelocity.current.set(0, 0, 0)
      return
    }

    const dt = Math.min(delta, 0.05)
    const keys = keysPressedRef.current

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0)

    const moveDir = new THREE.Vector3(0, 0, 0)
    if (keys.forward) moveDir.add(forward)
    if (keys.backward) moveDir.sub(forward)
    if (keys.right) moveDir.add(right)
    if (keys.left) moveDir.sub(right)
    if (keys.up) moveDir.add(up)
    if (keys.down) moveDir.sub(up)

    let speedMultiplier = 1.0
    if (keys.fast) speedMultiplier *= 3.0
    if (keys.slow) speedMultiplier *= 0.25

    const targetSpeed = flySpeedRef.current * speedMultiplier
    const targetVelocity = new THREE.Vector3(0, 0, 0)
    if (moveDir.lengthSq() > 0.0001) {
      moveDir.normalize()
      targetVelocity.copy(moveDir).multiplyScalar(targetSpeed)
    }

    const damping = 15
    const alpha = 1 - Math.exp(-damping * dt)
    currentVelocity.current.lerp(targetVelocity, alpha)

    if (currentVelocity.current.lengthSq() > 0.000001) {
      camera.position.addScaledVector(currentVelocity.current, dt)
      camera.updateMatrixWorld(true)
    }
  })

  return null
}
