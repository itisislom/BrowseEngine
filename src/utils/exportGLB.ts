import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

export async function exportSceneToGLB(
  scene: THREE.Object3D,
  filename?: string
): Promise<ArrayBuffer> {
  scene.updateMatrixWorld(true)

  let exportTarget: THREE.Object3D = scene
  let temporaryGroup: THREE.Group | null = null

  if (scene instanceof THREE.Scene) {
    temporaryGroup = new THREE.Group()
    temporaryGroup.name = scene.name
    temporaryGroup.position.copy(scene.position)
    temporaryGroup.quaternion.copy(scene.quaternion)
    temporaryGroup.scale.copy(scene.scale)
    temporaryGroup.userData = { ...scene.userData }
    const children = [...scene.children]
    for (const child of children) {
      temporaryGroup.add(child)
    }
    temporaryGroup.updateMatrixWorld(true)
    exportTarget = temporaryGroup
  }

  const exporter = new GLTFExporter()

  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      exporter.parse(
        exportTarget,
        (result) => {
          if (result instanceof ArrayBuffer) {
            if (filename) {
              const blob = new Blob([result], { type: 'model/gltf-binary' })
              const link = document.createElement('a')
              const url = URL.createObjectURL(blob)
              link.href = url
              link.download = filename.endsWith('.glb') ? filename : `${filename}.glb`
              link.click()
              URL.revokeObjectURL(url)
            }
            resolve(result)
          } else {
            reject(new Error('GLTFExporter did not return an ArrayBuffer'))
          }
        },
        (error) => {
          reject(error)
        },
        { binary: true, trs: true, onlyVisible: true }
      )
    })
  } finally {
    if (temporaryGroup && scene instanceof THREE.Scene) {
      const children = [...temporaryGroup.children]
      for (const child of children) {
        scene.add(child)
      }
      scene.updateMatrixWorld(true)
    }
  }
}
