// Static geometry derived from the map JSON. ONE source of truth for the corner
// vertices so the client render mesh and the server/Rapier collider can never
// disagree about where a wall or ramp actually is (PRD §7, §16.1, §24).
//
// Ramp convention: `dir` is the horizontal direction the slope ASCENDS toward.
// The full-height (vertical) face is on the `dir` side; the slope descends to
// floor level on the `-dir` side. A ramp is a right-triangular prism whose two
// triangular faces are perpendicular to the other horizontal axis.

import type { Vec3, Vec3Tuple } from './math';
import { v3 } from './math';

export type RampDir = '+x' | '-x' | '+z' | '-z';

export interface SolidBox {
  type: 'box';
  pos: Vec3Tuple; // center
  size: Vec3Tuple; // full extents
}

export interface SolidRamp {
  type: 'ramp';
  pos: Vec3Tuple; // center of bounding box
  size: Vec3Tuple; // full extents of bounding box
  dir: RampDir;
}

export type Solid = SolidBox | SolidRamp;

export interface SpawnPoint {
  pos: Vec3Tuple;
  yaw: number; // degrees
}

export interface MapData {
  solids: Solid[];
  spawns: SpawnPoint[];
  killY: number;
}

/** World-space corner vertices: box -> 8, ramp -> 6 (triangular prism). */
export function solidVertices(s: Solid): Vec3[] {
  const [cx, cy, cz] = s.pos;
  const [sx, sy, sz] = s.size;
  const hx = sx / 2,
    hy = sy / 2,
    hz = sz / 2;
  const by = cy - hy;
  const ty = cy + hy;

  if (s.type === 'box') {
    return [
      v3(cx - hx, by, cz - hz),
      v3(cx + hx, by, cz - hz),
      v3(cx + hx, by, cz + hz),
      v3(cx - hx, by, cz + hz),
      v3(cx - hx, ty, cz - hz),
      v3(cx + hx, ty, cz - hz),
      v3(cx + hx, ty, cz + hz),
      v3(cx - hx, ty, cz + hz),
    ];
  }

  // Ramp: which horizontal axis the slope runs along, and which is the width.
  const alongX = s.dir === '+x' || s.dir === '-x';
  const highPos = s.dir === '+x' || s.dir === '+z'; // high face on the + side?

  // width = perpendicular horizontal axis; depth = the dir axis
  const verts: Vec3[] = [];
  for (const w of [-1, 1]) {
    if (alongX) {
      const wz = cz + w * hz; // width along z
      const toeX = highPos ? cx - hx : cx + hx; // low edge on the -dir side
      const backX = highPos ? cx + hx : cx - hx; // high edge on the +dir side
      verts.push(v3(toeX, by, wz)); // toe (low)
      verts.push(v3(backX, by, wz)); // back bottom
      verts.push(v3(backX, ty, wz)); // back top (high edge)
    } else {
      const wx = cx + w * hx; // width along x
      const toeZ = highPos ? cz - hz : cz + hz;
      const backZ = highPos ? cz + hz : cz - hz;
      verts.push(v3(wx, by, toeZ));
      verts.push(v3(wx, by, backZ));
      verts.push(v3(wx, ty, backZ));
    }
  }
  return verts;
}

/**
 * Triangle indices into solidVertices() for a closed trimesh.
 * Box -> 12 triangles (36 indices). Ramp -> 8 triangles (24 indices).
 * Winding is outward-facing CCW; render ramps DoubleSide if in doubt.
 */
export function solidTriangleIndices(s: Solid): number[] {
  if (s.type === 'box') {
    // verts: 0-3 bottom (CCW from -x-z), 4-7 top
    return [
      // bottom (y-)
      0, 2, 1, 0, 3, 2,
      // top (y+)
      4, 5, 6, 4, 6, 7,
      // -z face
      0, 1, 5, 0, 5, 4,
      // +z face
      3, 7, 6, 3, 6, 2,
      // -x face
      0, 4, 7, 0, 7, 3,
      // +x face
      1, 2, 6, 1, 6, 5,
    ];
  }
  // Ramp prism. Vertices: side A = [0:toe, 1:backBottom, 2:backTop],
  // side B = [3:toe, 4:backBottom, 5:backTop].
  return [
    // triangular faces
    0, 2, 1, // side A
    3, 4, 5, // side B
    // bottom quad (toe + backBottom)
    0, 1, 4, 0, 4, 3,
    // back vertical wall (backBottom + backTop)
    1, 2, 5, 1, 5, 4,
    // slope (toe + backTop)
    0, 3, 5, 0, 5, 2,
  ];
}

/** Flat Float32 vertex buffer + index array for building a BufferGeometry / trimesh. */
export function solidMeshArrays(s: Solid): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const verts = solidVertices(s);
  const out = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    out[i * 3] = verts[i].x;
    out[i * 3 + 1] = verts[i].y;
    out[i * 3 + 2] = verts[i].z;
  }
  return { vertices: out, indices: new Uint32Array(solidTriangleIndices(s)) };
}

/** Walkable slope surface unit normal for a ramp (used for slide-down accel cues). */
export function rampNormal(s: SolidRamp): Vec3 {
  const [, sy] = s.size;
  const [sx, , sz] = s.size;
  // slope rises over the dir-axis run; normal points up and against the ascent.
  const alongX = s.dir === '+x' || s.dir === '-x';
  const run = alongX ? sx : sz;
  const rise = sy;
  const len = Math.hypot(run, rise) || 1;
  const ny = run / len;
  const horiz = -rise / len; // points toward the toe (down-slope horizontal)
  const sign = s.dir === '+x' || s.dir === '+z' ? 1 : -1;
  if (alongX) return v3(sign * horiz, ny, 0);
  return v3(0, ny, sign * horiz);
}
