import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { useEditorStore } from '../store/useEditorStore'
import { flyAim, tickFlyAim } from '../utils/flyAim'

export function FlyOutline() {
  const { gl, scene, camera, size } = useThree()
  const sceneRoot = useEditorStore((state) => state.sceneRoot)

  const composerRef = useRef<EffectComposer | null>(null)
  const outlinePassRef = useRef<OutlinePass | null>(null)

  useEffect(() => {
    const dpr = gl.getPixelRatio()
    const renderTarget = new THREE.WebGLRenderTarget(size.width * dpr, size.height * dpr, {
      type: THREE.HalfFloatType,
      samples: 4,
    })

    const composer = new EffectComposer(gl, renderTarget)
    composer.setPixelRatio(dpr)
    composer.setSize(size.width, size.height)

    const renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    const outlinePass = new OutlinePass(
      new THREE.Vector2(size.width, size.height),
      scene,
      camera
    )
    outlinePass.visibleEdgeColor.set('#00b4d8')
    outlinePass.hiddenEdgeColor.set('#00b4d8')
    outlinePass.edgeGlow = 0
    outlinePass.edgeThickness = 2
    outlinePass.edgeStrength = 3
    outlinePass.pulsePeriod = 0
    composer.addPass(outlinePass)

    const outputPass = new OutputPass()
    composer.addPass(outputPass)

    composerRef.current = composer
    outlinePassRef.current = outlinePass

    return () => {
      composerRef.current = null
      outlinePassRef.current = null
      renderPass.dispose()
      outlinePass.dispose()
      outputPass.dispose()
      composer.dispose()
      renderTarget.dispose()
    }
  }, [gl, scene, camera])

  useEffect(() => {
    const composer = composerRef.current
    const outlinePass = outlinePassRef.current
    if (composer && outlinePass) {
      const dpr = gl.getPixelRatio()
      composer.setPixelRatio(dpr)
      composer.setSize(size.width, size.height)
      outlinePass.setSize(size.width, size.height)
    }
  }, [size, gl])

  useFrame(() => {
    const composer = composerRef.current
    const outlinePass = outlinePassRef.current
    if (!composer || !outlinePass) return

    tickFlyAim(camera, sceneRoot, performance.now())

    const target = flyAim.object
    if (target) {
      outlinePass.selectedObjects = [target]
    } else if (outlinePass.selectedObjects.length > 0) {
      outlinePass.selectedObjects = []
    }

    composer.render()
  }, 1)

  return null
}
