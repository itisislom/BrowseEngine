# BrowseEngine

> High-performance browser-based 3D model viewer and editor for GLB / glTF assets.

BrowseEngine is a CAD/DCC-inspired web application for viewing, inspecting, posing, editing, and exporting 3D models directly in the browser with zero external CDN dependencies.

---

## Features

- **GLB / glTF Import & Export**:
  - Full-fidelity round-trip import and export with Three.js `GLTFExporter`.
  - Preserves hierarchy, local TRS transforms, node visibility, and skeleton joint poses.
  - Automatic Draco mesh decompression support.
- **Outliner & Scene Tree**:
  - Hierarchical tree representation of scene nodes, groups, meshes, and bones.
  - Inline node renaming (F2 or double-click) with validation.
  - Node deletion (Delete or X) with subtree safety checks and undo / redo restoration.
- **Transform Gizmos**:
  - Translate (W), Rotate (E), Scale (R) gizmos.
  - Pivot mode switching: Geometry Center vs. Object Origin.
  - Coordinate orientation: Global vs. Local coordinate spaces.
- **Skeleton & Bone Tools**:
  - Custom 3D octahedron bone markers with connection lines.
  - X-Ray toggle for occluded joint selection and visualization.
  - Adjustable bone marker size.
- **Blender-style Navigation**:
  - OrbitControls configured for snappy, non-inertial rotation and panning.
  - Progressive exponential wheel zoom towards mouse target.
  - Navigation orientation gizmo.
  - **Free Flight Navigation (`Shift + \``)**:
    - WASD movement, Q/E vertical elevation, Shift boost, Alt slow crawl.
    - Centered viewport crosshair.
    - Real-time silhouette outline highlighting on hovered meshes.
    - Surface coordinate pinning on `Key C` with Godot `Vector3(...)` auto-copying to clipboard.
- **Memory & Reliability**:
  - Explicit recursive GPU resource disposal (geometries, materials, textures, blob URLs).
  - IndexedDB session persistence for auto-restoring edits between page reloads.

---

## Tech Stack

- **Framework**: React 19, TypeScript
- **3D Engine**: Three.js, React Three Fiber (R3F), `@react-three/drei`
- **State Management**: Zustand
- **Styling**: Vanilla CSS (dark CAD/DCC aesthetic)
- **Bundler**: Vite

---

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- npm, pnpm, or yarn

### Installation

```bash
git clone https://github.com/itisislom/BrowseEngine.git
cd BrowseEngine
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Production Build

```bash
npm run build
npm run preview
```

---

## Shortcuts

| Shortcut | Action |
|---|---|
| `W` | Translate Tool |
| `E` | Rotate Tool |
| `R` | Scale Tool |
| `B` | Toggle Bones Visibility |
| `F2` | Rename Selected Node |
| `Delete` / `X` | Delete Selected Node(s) |
| `Ctrl + Z` / `Ctrl + Y` | Undo / Redo |
| `Shift + \`` | Enter / Confirm Fly Mode |
| `C` (in Fly Mode) | Pin / Unpin Surface Coordinate & Copy Vector3 |
| `Esc` (in Fly Mode) | Cancel Fly Mode |

---

## License

[MIT](LICENSE)
