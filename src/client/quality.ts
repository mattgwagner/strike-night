// Graphics quality: 'high' (the full look) or 'low' (integrated GPUs, Chromebooks).
// Low keeps the map, players, hits and view identical; it only spends less per pixel:
// pixel ratio ≤ 1 (0.75 on a very wide window), no MSAA, the map's point lights merged
// down to a handful, Lambert instead of PBR on the world, no muzzle lights, fewer
// decals/particles, and smoke drawn with fewer, larger puffs.
export type Quality = 'high' | 'low';

export const isQuality = (q: unknown): q is Quality => q === 'high' || q === 'low';

/** First-run guess from the device alone: few cores, little memory, or ChromeOS. */
export function lowEndDevice(nav: Navigator = navigator): boolean {
  const cores = nav.hardwareConcurrency;
  const mem = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
  if (cores && cores <= 4) return true;
  if (mem && mem <= 4) return true;
  return /\bCrOS\b/.test(nav.userAgent);
}

/** Canvas pixel ratio for a quality level. */
export function pixelRatioFor(q: Quality, dpr = devicePixelRatio, width = innerWidth): number {
  if (q === 'high') return Math.min(dpr, 2);
  return Math.min(dpr, width >= 1600 ? 0.75 : 1);
}

/** Below this average over the first live frames, a player who never chose gets Low. */
export const AUTO_LOW_FPS = 40;
export const AUTO_PROBE_FRAMES = 60;
