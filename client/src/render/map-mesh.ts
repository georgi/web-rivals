// Build the static level mesh from MapData. Boxes -> BoxGeometry; ramps ->
// BufferGeometry from the shared solidMeshArrays so render and collider can
// never disagree on a surface. Flat MeshStandardMaterial, no textures (PRD §10).

import * as THREE from 'three';
import type { MapData, Solid } from '@rivals/shared';
import { solidMeshArrays } from '@rivals/shared';

// Muted low-poly palette; index-varied so adjacent solids read apart.
const WALL_HUES = [0x6f7785, 0x7a8290, 0x656d7a, 0x808896, 0x747c8a];
const FLOOR_COLOR = 0x4a525c;
const RAMP_COLOR = 0x8a7f6e;

// A solid is treated as "floor" when it is wide/deep and thin in y, sitting low.
function isFloor(s: Solid): boolean {
  const [, sy] = s.size;
  const [sx, , sz] = s.size;
  return s.type === 'box' && sy <= 1.0 && sx >= 8 && sz >= 8;
}

function buildBox(s: Solid, index: number): THREE.Mesh {
  const [sx, sy, sz] = s.size;
  const [px, py, pz] = s.pos;
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const color = isFloor(s) ? FLOOR_COLOR : WALL_HUES[index % WALL_HUES.length];
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(px, py, pz);
  return mesh;
}

function buildRamp(s: Solid): THREE.Mesh {
  const { vertices, indices } = solidMeshArrays(s);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: RAMP_COLOR,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  // Vertices are already world-space; mesh stays at origin.
  return new THREE.Mesh(geo, mat);
}

export function buildMapMesh(map: MapData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';
  map.solids.forEach((s, i) => {
    group.add(s.type === 'ramp' ? buildRamp(s) : buildBox(s, i));
  });
  return group;
}
