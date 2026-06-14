// Build the static level mesh from MapData. Boxes -> BoxGeometry; ramps ->
// BufferGeometry from the shared solidMeshArrays so render and collider can
// never disagree on a surface.
//
// Look: the bright "clean arena" style (Roblox Rivals) — uniform near-white
// surfaces clad in a tiled panel texture with subtle seams and a grey "+" mark
// at every tile intersection. Edges read from AO + light shadows, not colour.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapData, Solid, SolidRamp } from '@rivals/shared';
import { solidMeshArrays } from '@rivals/shared';

// Near-white cladding for every surface; the tile texture + shadows carry the
// detail, so a single colour keeps the arena clean like the reference.
const SURFACE_COLOR = 0xdde1e8;
// One tile = this many world units. Sets the grid density across all geometry.
const TILE_WORLD = 2.0;

// Shared tile texture: white panel, faint seam border, and a grey "+" stamped
// across each corner so that — once the tile repeats — every grid intersection
// carries a cross. Built once; each mesh clones it to set its own repeat.
let _tileTex: THREE.Texture | null = null;
function tileTexture(): THREE.Texture {
  if (_tileTex) return _tileTex;
  const px = 256;
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;

  // Panel base.
  ctx.fillStyle = '#eceef2';
  ctx.fillRect(0, 0, px, px);

  // Seam border (tiles into a continuous thin grid between panels).
  ctx.strokeStyle = 'rgba(150,159,173,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, px - 2, px - 2);

  // "+" marks across the four corners → a full cross at every intersection once
  // the texture repeats. Drawn beyond the canvas edge; wrapping reunites them.
  ctx.fillStyle = 'rgba(120,129,146,0.62)';
  const L = 24; // arm half-length
  const T = 7; // arm thickness
  for (const [cx, cy] of [
    [0, 0],
    [px, 0],
    [0, px],
    [px, px],
  ]) {
    ctx.fillRect(cx - L, cy - T / 2, 2 * L, T); // horizontal arm
    ctx.fillRect(cx - T / 2, cy - L, T, 2 * L); // vertical arm
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16; // keep grazing-angle floor tiles crisp instead of washing
  _tileTex = tex;
  return tex;
}

// Multiply a geometry's UVs in place so the tile texture repeats `rx`×`ry` times
// across it. Baking the repeat into the UVs (instead of per-mesh texture.repeat)
// lets every solid share ONE texture + ONE material, so the whole map merges to
// a single draw call. The shared texture stays at wrap-repeat with repeat=(1,1).
function bakeRepeat(geo: THREE.BufferGeometry, rx: number, ry: number): void {
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
  }
  uv.needsUpdate = true;
}

// A solid is treated as "floor" when it is wide/deep and thin in y, sitting low.
function isFloor(s: Solid): boolean {
  const [, sy] = s.size;
  const [sx, , sz] = s.size;
  return s.type === 'box' && sy <= 1.0 && sx >= 8 && sz >= 8;
}

// Returns a world-positioned box geometry with the tile repeat baked into its
// UVs, ready to be merged into the single map mesh.
function buildBox(s: Solid): THREE.BufferGeometry {
  const [sx, sy, sz] = s.size;
  const [px, py, pz] = s.pos;
  const geo = new THREE.BoxGeometry(sx, sy, sz);

  // World-scaled tiling: floors tile across their footprint; uprights tile
  // their widest horizontal span across U and their height up V (BoxGeometry's
  // side faces map U to the wider horizontal axis, V to height).
  const floor = isFloor(s);
  const repeatX = (floor ? sx : Math.max(sx, sz)) / TILE_WORLD;
  const repeatY = (floor ? sz : sy) / TILE_WORLD;
  bakeRepeat(geo, repeatX, repeatY);

  geo.translate(px, py, pz);
  return geo;
}

// solidTriangleIndices winds ramp prisms with handedness that flips by dir (the
// +z / -x prisms wind INWARD), so on FrontSide their faces were culled and the
// ramps rendered see-through. Rather than mask it with DoubleSide, fix it at the
// source: for a convex solid a triangle winds inward iff its geometric normal
// points back toward the solid's centroid — flip those. Then FrontSide draws
// every face and computeVertexNormals yields genuinely-outward normals (correct
// lighting, standard shadows). Zero-alloc, indices rewritten in place. (Kept in
// the render layer to avoid touching the shared collider.)
function fixWindingOutward(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  if (!idx) return;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += pos.getX(i);
    cy += pos.getY(i);
    cz += pos.getZ(i);
  }
  cx /= pos.count;
  cy /= pos.count;
  cz /= pos.count;
  const arr = idx.array as Uint32Array;
  for (let t = 0; t < arr.length; t += 3) {
    const i0 = arr[t];
    const i1 = arr[t + 1];
    const i2 = arr[t + 2];
    const ax = pos.getX(i0);
    const ay = pos.getY(i0);
    const az = pos.getZ(i0);
    const e1x = pos.getX(i1) - ax;
    const e1y = pos.getY(i1) - ay;
    const e1z = pos.getZ(i1) - az;
    const e2x = pos.getX(i2) - ax;
    const e2y = pos.getY(i2) - ay;
    const e2z = pos.getZ(i2) - az;
    // Face normal (e1 × e2) and the triangle-centroid → solid-centroid vector.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const tcx = (ax + pos.getX(i1) + pos.getX(i2)) / 3 - cx;
    const tcy = (ay + pos.getY(i1) + pos.getY(i2)) / 3 - cy;
    const tcz = (az + pos.getZ(i1) + pos.getZ(i2)) / 3 - cz;
    // Normal pointing inward (toward centroid) → swap to wind outward.
    if (nx * tcx + ny * tcy + nz * tcz < 0) {
      arr[t + 1] = i2;
      arr[t + 2] = i1;
    }
  }
  idx.needsUpdate = true;
}

// Returns a world-space ramp geometry (vertices already world-positioned by the
// shared mesh builder) with planar world-grid UVs, ready to merge.
function buildRamp(s: Solid): THREE.BufferGeometry {
  const { vertices, indices } = solidMeshArrays(s);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  fixWindingOutward(geo); // BEFORE normals — so they come out outward
  geo.computeVertexNormals();

  // Planar UVs from world X/Z so the ramp's tiles line up with the floor grid
  // below it (vertices are already world-space). The slope stretches the tiles
  // slightly along its run — visually continuous and fine for an accent piece.
  // These already carry the world scale, so no repeat baking is needed.
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / TILE_WORLD;
    uv[i * 2 + 1] = pos.getZ(i) / TILE_WORLD;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  // Each ramp's high (back) wall is coplanar with the block face it climbs, so
  // the two quads z-fought into a shimmering striped band. Sink the RENDER
  // geometry a few cm up-slope (along the ramp's dir axis) so that buried wall
  // slips behind the block face. Cosmetic only — the Rapier collider is
  // untouched, so the sub-cm walk-surface shift is imperceptible.
  const dir = (s as SolidRamp).dir;
  const EPS = 0.04;
  if (dir === '+x') geo.translate(EPS, 0, 0);
  else if (dir === '-x') geo.translate(-EPS, 0, 0);
  else if (dir === '+z') geo.translate(0, 0, EPS);
  else if (dir === '-z') geo.translate(0, 0, -EPS);
  return geo;
}

// Build the whole static level as ONE merged mesh sharing ONE material + ONE
// texture. Every solid's tiling is baked into its UVs (boxes) or carried by
// world-space UVs (ramps), so collapsing them costs nothing visually but turns
// ~18 draw calls + 18 textures + 18 materials into 1 of each. The single mesh
// covers the arena so it's effectively always on-screen — culling it is moot.
export function buildMapMesh(map: MapData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'map';

  const geometries = map.solids.map((s) => (s.type === 'ramp' ? buildRamp(s) : buildBox(s)));
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();

  const material = new THREE.MeshStandardMaterial({
    color: SURFACE_COLOR,
    roughness: 0.88,
    metalness: 0.0,
    map: tileTexture(), // shared singleton; repeat stays (1,1), UVs carry scale
  });

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'map-merged';
  group.add(mesh);
  return group;
}
