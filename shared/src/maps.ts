// Map data accessors. The JSON file (map-crate.json) is the single source of
// truth; both client (mesh + collider) and server (collider + projectiles)
// consume it through here, so there is no second copy of the geometry anywhere.

import crateData from './map-crate.json';
import type { MapData } from './geometry';

export const CRATE_MAP: MapData = crateData as MapData;

export const MAPS: Record<string, MapData> = {
  crate: CRATE_MAP,
};

export const DEFAULT_MAP_ID = 'crate';

export function getMap(id: string): MapData {
  return MAPS[id] ?? CRATE_MAP;
}
