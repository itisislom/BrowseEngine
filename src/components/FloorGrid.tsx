import { useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { Grid, Line } from '@react-three/drei'

export function FloorGrid() {
  const gridRef = useRef<THREE.Mesh>(null)

  useLayoutEffect(() => {
    if (gridRef.current?.material) {
      const mat = gridRef.current.material as THREE.Material
      mat.depthWrite = false
    }
  }, [])

  return (
    <group position={[0, 0, 0]}>
      <Grid
        ref={gridRef}
        position={[0, 0, 0]}
        args={[100, 100]}
        cellSize={0.5}
        cellThickness={0.6}
        cellColor="#2a2d32"
        sectionSize={2.5}
        sectionThickness={1.1}
        sectionColor="#3e434c"
        fadeDistance={2000}
        fadeStrength={0}
        infiniteGrid
        renderOrder={0}
        raycast={() => null}
      />

      <Line
        points={[
          [-1000, 0.001, 0],
          [1000, 0.001, 0],
        ]}
        color="#ff3b4b"
        lineWidth={1.5}
        renderOrder={1}
        depthTest={true}
        depthWrite={false}
        polygonOffset={true}
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-2}
        raycast={() => null}
      />

      <Line
        points={[
          [0, 0.001, -1000],
          [0, 0.001, 1000],
        ]}
        color="#3884ff"
        lineWidth={1.5}
        renderOrder={1}
        depthTest={true}
        depthWrite={false}
        polygonOffset={true}
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-2}
        raycast={() => null}
      />

      <group position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <mesh raycast={() => null}>
          <ringGeometry args={[0.08, 0.12, 32]} />
          <meshBasicMaterial
            color="#ffffff"
            side={THREE.DoubleSide}
            transparent
            opacity={0.85}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
        <mesh raycast={() => null}>
          <circleGeometry args={[0.03, 16]} />
          <meshBasicMaterial
            color="#ffffff"
            side={THREE.DoubleSide}
            transparent
            opacity={0.9}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      </group>
    </group>
  )
}

