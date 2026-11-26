import * as THREE from 'three';

export type GcodeFeatureType =
  | 'outer_wall'
  | 'inner_wall'
  | 'sparse_infill'
  | 'solid_infill'
  | 'overhang_bridge'
  | 'support'
  | 'skirt_brim'
  | 'other';

export type PreviewColorMode = 'line-type' | 'filament' | 'speed';

export interface FeatureStat {
  segmentCount: number;
  lengthMm: number;
  sharePct: number;
}

export const GCODE_FEATURE_ORDER: GcodeFeatureType[] = [
  'outer_wall',
  'inner_wall',
  'sparse_infill',
  'solid_infill',
  'overhang_bridge',
  'support',
  'skirt_brim',
  'other',
];

/** Iconic OrcaSlicer GCodeViewer line-type colors. */
export const FEATURE_COLORS: Record<GcodeFeatureType, string> = {
  outer_wall: '#F97316',
  inner_wall: '#EAB308',
  sparse_infill: '#DC2626',
  solid_infill: '#A855F7',
  overhang_bridge: '#2563EB',
  support: '#16A34A',
  skirt_brim: '#06B6D4',
  other: '#64748B',
};

export const TRAVEL_COLOR = '#38BDF8';

const FEATURE_TO_INDEX: Record<GcodeFeatureType, number> = {
  outer_wall: 0,
  inner_wall: 1,
  sparse_infill: 2,
  solid_infill: 3,
  overhang_bridge: 4,
  support: 5,
  skirt_brim: 6,
  other: 7,
};
const TRAVEL_KIND = 8;

const DEFAULT_EXTRUSION_WIDTH_MM = 0.42;
const DEFAULT_LAYER_HEIGHT_MM = 0.2;
const DEFAULT_SPEED_MM_S = 60;
const BED_FILTER_MARGIN_MM = 1.0;

export interface ParsedLayerMeta {
  z: number;
  moveCount: number;
  /** Cumulative extrusion segment counts per feature at the START of this layer. */
  startByFeature: Record<GcodeFeatureType, number>;
  /** Cumulative extrusion segment counts per feature at the END of this layer. */
  endByFeature: Record<GcodeFeatureType, number>;
  /** Travel segment index range [travelStart, travelEnd) for this layer. */
  travelStart: number;
  travelEnd: number;
  /** Per-move kind (0..7 = feature index, 8 = travel). */
  moveKinds: Uint8Array;
  /** Nozzle XY position at the end of each move (length = moveCount * 2). */
  moveEndXY: Float32Array;
  /** Initial nozzle XY position before move 0 of this layer. */
  startX: number;
  startY: number;
}

export interface ParsedGcode {
  layerCount: number;
  layerHeightMm: number;
  layers: ParsedLayerMeta[];
  presentFeatures: GcodeFeatureType[];
  featureSegmentCounts: Record<GcodeFeatureType, number>;
  featureStats: Record<GcodeFeatureType, FeatureStat>;
  speedRange: { minMmS: number; maxMmS: number };
  totalExtrusionSegments: number;
  totalTravelSegments: number;
  /** Packed X0, Y0, ZTop, X1, Y1, ZTop, ZBot per segment for each feature (7 floats per segment). */
  extrusionSegmentsByFeature: Record<GcodeFeatureType, Float32Array>;
  /** Packed WidthMm, HeightMm, SpeedMmS per segment for each feature (3 floats per segment). */
  extrusionPropsByFeature?: Record<GcodeFeatureType, Float32Array>;
  /** Packed X0, Y0, Z0, X1, Y1, Z1 per travel segment (6 floats per segment). */
  travelSegments: Float32Array;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
}

export interface ParseGcodeOptions {
  bedX: number;
  bedY: number;
  posX?: number;
  posY?: number;
}

function createZeroFeatureCounts(): Record<GcodeFeatureType, number> {
  return {
    outer_wall: 0,
    inner_wall: 0,
    sparse_infill: 0,
    solid_infill: 0,
    overhang_bridge: 0,
    support: 0,
    skirt_brim: 0,
    other: 0,
  };
}

function createZeroFeatureStats(): Record<GcodeFeatureType, FeatureStat> {
  return {
    outer_wall: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    inner_wall: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    sparse_infill: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    solid_infill: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    overhang_bridge: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    support: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    skirt_brim: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
    other: { segmentCount: 0, lengthMm: 0, sharePct: 0 },
  };
}

function createEmptyFeatureFloatMap(): Record<GcodeFeatureType, Float32Array> {
  return {
    outer_wall: new Float32Array(0),
    inner_wall: new Float32Array(0),
    sparse_infill: new Float32Array(0),
    solid_infill: new Float32Array(0),
    overhang_bridge: new Float32Array(0),
    support: new Float32Array(0),
    skirt_brim: new Float32Array(0),
    other: new Float32Array(0),
  };
}

/**
 * Map OrcaSlicer / PrusaSlicer `;TYPE:` and `;FEATURE:` labels into `GcodeFeatureType`.
 */
function mapCommentToFeature(rawType: string): GcodeFeatureType {
  const s = rawType.trim().toLowerCase();
  if (!s) return 'other';
  if (s.includes('outer wall') || s.includes('external perimeter')) {
    return 'outer_wall';
  }
  if (s.includes('overhang') || s.includes('bridge')) {
    return 'overhang_bridge';
  }
  if (
    s.includes('inner wall') ||
    s.includes('internal perimeter') ||
    s.includes('perimeter') ||
    s.includes('gap infill')
  ) {
    return 'inner_wall';
  }
  if (
    s.includes('top surface') ||
    s.includes('bottom surface') ||
    s.includes('internal solid infill') ||
    s.includes('solid infill') ||
    s.includes('ironing')
  ) {
    return 'solid_infill';
  }
  if (s.includes('support')) {
    return 'support';
  }
  if (
    s.includes('skirt') ||
    s.includes('brim') ||
    s.includes('prime tower') ||
    s.includes('wipe tower')
  ) {
    return 'skirt_brim';
  }
  if (s.includes('sparse infill') || s.includes('infill')) {
    return 'sparse_infill';
  }
  if (s === 'custom') {
    return 'other';
  }
  return 'other';
}

interface PrintableAreaInfo {
  centerX: number;
  centerY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function parsePrintableAreaInfo(value: string): PrintableAreaInfo | null {
  const parts = value.split(',');
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    const sep = token.indexOf('x');
    if (sep <= 0) continue;
    const x = Number(token.slice(0, sep));
    const y = Number(token.slice(sep + 1));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
  }

  if (count < 2) return null;
  return {
    centerX: 0.5 * (minX + maxX),
    centerY: 0.5 * (minY + maxY),
    minX,
    maxX,
    minY,
    maxY,
  };
}

function computeSpeedRange(segments: RawSegment[]): { minMmS: number; maxMmS: number } {
  let count = 0;
  let rawMin = Infinity;
  let rawMax = -Infinity;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.isTravel) continue;
    const spd = seg.speedMmS;
    if (!Number.isFinite(spd) || spd <= 0) continue;
    count++;
    if (spd < rawMin) rawMin = spd;
    if (spd > rawMax) rawMax = spd;
  }

  if (count === 0) {
    return { minMmS: 0, maxMmS: 0 };
  }

  if (count <= 20) {
    return {
      minMmS: Number(Math.max(1, Math.min(1000, rawMin)).toFixed(2)),
      maxMmS: Number(Math.max(1, Math.min(1000, rawMax)).toFixed(2)),
    };
  }

  // O(N) 0.5 mm/s histogram (0..1000 mm/s -> 2001 buckets) for 5th-95th percentile
  const MAX_BUCKET = 2000;
  const buckets = new Uint32Array(MAX_BUCKET + 1);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.isTravel) continue;
    const spd = seg.speedMmS;
    if (!Number.isFinite(spd) || spd <= 0) continue;
    const b = Math.max(0, Math.min(MAX_BUCKET, Math.round(spd * 2)));
    buckets[b]++;
  }

  const targetLow = Math.max(1, Math.floor(count * 0.05));
  const targetHigh = Math.min(count, Math.ceil(count * 0.95));
  let cumulative = 0;
  let minMmS = rawMin;
  let maxMmS = rawMax;
  let foundLow = false;

  for (let b = 0; b <= MAX_BUCKET; b++) {
    const c = buckets[b];
    if (c === 0) continue;
    cumulative += c;
    if (!foundLow && cumulative >= targetLow) {
      minMmS = b * 0.5;
      foundLow = true;
    }
    if (cumulative >= targetHigh) {
      maxMmS = b * 0.5;
      break;
    }
  }

  minMmS = Number(Math.max(1, Math.min(1000, minMmS)).toFixed(2));
  maxMmS = Number(Math.max(minMmS, Math.min(1000, maxMmS)).toFixed(2));
  return { minMmS, maxMmS };
}

interface RawSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
  zBot: number;
  widthMm: number;
  heightMm: number;
  speedMmS: number;
  lengthMm: number;
  featureIdx: number;
  isTravel: boolean;
  layerIdx: number;
}

export function parseGcode(text: string, options: ParseGcodeOptions): ParsedGcode {
  const bedX = options.bedX > 0 ? options.bedX : 250;
  const bedY = options.bedY > 0 ? options.bedY : 220;
  const expectedPosX = options.posX ?? 0;
  const expectedPosY = options.posY ?? 0;

  const hasLayerChangeMarkers = text.includes(';LAYER_CHANGE') || text.includes('; LAYER_CHANGE');
  const hasTypeMarkers =
    text.includes(';TYPE:') ||
    text.includes('; TYPE:') ||
    text.includes(';FEATURE:') ||
    text.includes('; FEATURE:');

  let absXYZ = true;
  let absE = true; // Standard G-code default until M83 is encountered
  let curX = 0;
  let curY = 0;
  let curZ = 0;
  let curE = 0;

  let layerHeightMm = DEFAULT_LAYER_HEIGHT_MM;
  let currentWidthMm = DEFAULT_EXTRUSION_WIDTH_MM;
  let currentHeightMm = DEFAULT_LAYER_HEIGHT_MM;
  let hasExplicitHeight = false;
  let currentSpeedMmS = DEFAULT_SPEED_MM_S;

  let explicitOriginCenter = false;
  let printableArea: PrintableAreaInfo | null = null;
  let currentFeature: GcodeFeatureType = 'other';
  let sawTypeComment = false;
  let seenExplicitLayerChange = false;
  let pendingLayerZ: number | null = null;
  let currentLayerIdx = -1;
  let prevLayerZ = 0;

  // Start/end purge filtering state
  let inModelPrint = !hasLayerChangeMarkers && !hasTypeMarkers;
  let hasAnyModelExtrusion = false;
  let inEndGcode = false;

  const layerZs: number[] = [];
  const layerHasMoves: boolean[] = [];
  const rawSegments: RawSegment[] = [];

  // Bounds of extrusion moves (preferring moves after first ;TYPE: so start purge lines don't skew centering)
  let postTypeMinX = Infinity;
  let postTypeMaxX = -Infinity;
  let postTypeMinY = Infinity;
  let postTypeMaxY = -Infinity;
  let anyExtMinX = Infinity;
  let anyExtMaxX = -Infinity;
  let anyExtMinY = Infinity;
  let anyExtMaxY = -Infinity;

  const startNewLayer = (zVal: number) => {
    if (layerZs.length > 0) {
      prevLayerZ = layerZs[layerZs.length - 1];
    }
    layerZs.push(zVal);
    layerHasMoves.push(false);
    currentLayerIdx = layerZs.length - 1;
    if (zVal > prevLayerZ + 0.02 && zVal - prevLayerZ <= 1.0 && prevLayerZ > 0) {
      layerHeightMm = Number((zVal - prevLayerZ).toFixed(3));
    }
  };

  const ensureLayerForMove = (zVal: number) => {
    if (currentLayerIdx < 0) {
      startNewLayer(zVal > 0 ? zVal : layerHeightMm);
    } else if (!seenExplicitLayerChange && zVal > layerZs[currentLayerIdx] + 0.04) {
      startNewLayer(zVal);
    }
  };

  let lastExtLayerIdx = -1;
  let lastExtFeatureIdx = -1;
  let lastExtIdx = -1;
  let lastExtDx = 0;
  let lastExtDy = 0;

  const pushSegment = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    isExtrude: boolean
  ) => {
    if (!inModelPrint || inEndGcode) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;

    ensureLayerForMove(z);
    const layerZ = layerZs[currentLayerIdx] > 0 ? layerZs[currentLayerIdx] : z;
    const segHeight = hasExplicitHeight ? currentHeightMm : layerHeightMm;
    const zBot = Math.max(0, layerZ - segHeight);
    const actualHeight = Math.max(0.02, layerZ - zBot);
    const segWidth = currentWidthMm;
    const segSpeed = currentSpeedMmS;

    layerHasMoves[currentLayerIdx] = true;

    if (isExtrude) {
      hasAnyModelExtrusion = true;
      const fIdx = FEATURE_TO_INDEX[currentFeature];
      // Merge tiny nearly-collinear extrusion segments (< 0.1 mm) with matching bead properties
      if (
        lastExtIdx >= 0 &&
        lastExtLayerIdx === currentLayerIdx &&
        lastExtFeatureIdx === fIdx &&
        len < 0.1
      ) {
        const prev = rawSegments[lastExtIdx];
        if (
          Math.abs(prev.widthMm - segWidth) < 0.01 &&
          Math.abs(prev.heightMm - actualHeight) < 0.01 &&
          Math.abs(prev.speedMmS - segSpeed) < 1.0
        ) {
          const prevLen = Math.hypot(lastExtDx, lastExtDy);
          if (prevLen > 1e-5) {
            const dot = (lastExtDx * dx + lastExtDy * dy) / (prevLen * len);
            if (dot > 0.998) {
              prev.x1 = x1;
              prev.y1 = y1;
              prev.lengthMm = Math.hypot(prev.x1 - prev.x0, prev.y1 - prev.y0);
              lastExtDx = prev.x1 - prev.x0;
              lastExtDy = prev.y1 - prev.y0;
              if (x1 < anyExtMinX) anyExtMinX = x1;
              if (x1 > anyExtMaxX) anyExtMaxX = x1;
              if (y1 < anyExtMinY) anyExtMinY = y1;
              if (y1 > anyExtMaxY) anyExtMaxY = y1;
              if (sawTypeComment) {
                if (x1 < postTypeMinX) postTypeMinX = x1;
                if (x1 > postTypeMaxX) postTypeMaxX = x1;
                if (y1 < postTypeMinY) postTypeMinY = y1;
                if (y1 > postTypeMaxY) postTypeMaxY = y1;
              }
              return;
            }
          }
        }
      }

      rawSegments.push({
        x0,
        y0,
        x1,
        y1,
        z: layerZ,
        zBot,
        widthMm: segWidth,
        heightMm: actualHeight,
        speedMmS: segSpeed,
        lengthMm: len,
        featureIdx: fIdx,
        isTravel: false,
        layerIdx: currentLayerIdx,
      });
      lastExtIdx = rawSegments.length - 1;
      lastExtLayerIdx = currentLayerIdx;
      lastExtFeatureIdx = fIdx;
      lastExtDx = dx;
      lastExtDy = dy;

      if (x0 < anyExtMinX) anyExtMinX = x0;
      if (x0 > anyExtMaxX) anyExtMaxX = x0;
      if (x1 < anyExtMinX) anyExtMinX = x1;
      if (x1 > anyExtMaxX) anyExtMaxX = x1;
      if (y0 < anyExtMinY) anyExtMinY = y0;
      if (y0 > anyExtMaxY) anyExtMaxY = y0;
      if (y1 < anyExtMinY) anyExtMinY = y1;
      if (y1 > anyExtMaxY) anyExtMaxY = y1;
      if (sawTypeComment) {
        if (x0 < postTypeMinX) postTypeMinX = x0;
        if (x0 > postTypeMaxX) postTypeMaxX = x0;
        if (x1 < postTypeMinX) postTypeMinX = x1;
        if (x1 > postTypeMaxX) postTypeMaxX = x1;
        if (y0 < postTypeMinY) postTypeMinY = y0;
        if (y0 > postTypeMaxY) postTypeMaxY = y0;
        if (y1 < postTypeMinY) postTypeMinY = y1;
        if (y1 > postTypeMaxY) postTypeMaxY = y1;
      }
    } else {
      lastExtIdx = -1;
      rawSegments.push({
        x0,
        y0,
        x1,
        y1,
        z: layerZ,
        zBot,
        widthMm: segWidth,
        heightMm: actualHeight,
        speedMmS: segSpeed,
        lengthMm: len,
        featureIdx: TRAVEL_KIND,
        isTravel: true,
        layerIdx: currentLayerIdx,
      });
    }
  };

  const textLen = text.length;
  let pos = 0;
  while (pos < textLen) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = textLen;
    const rawLine = text.slice(pos, nl).trim();
    pos = nl + 1;

    if (!rawLine) continue;

    // Inspect comment directives (always read even after inEndGcode so trailing config blocks are parsed)
    const semiIdx = rawLine.indexOf(';');
    if (semiIdx >= 0) {
      const comment = rawLine.slice(semiIdx + 1).trim();
      if (comment) {
        const upperComment = comment.toUpperCase();
        if (upperComment.startsWith('LAYER_CHANGE')) {
          if (!inEndGcode) {
            inModelPrint = true;
            seenExplicitLayerChange = true;
            const nextZ =
              pendingLayerZ ??
              (layerZs.length > 0 ? layerZs[layerZs.length - 1] + layerHeightMm : layerHeightMm);
            pendingLayerZ = null;
            startNewLayer(nextZ);
          }
        } else if (upperComment.startsWith('Z:')) {
          const zVal = Number(comment.slice(2).trim());
          if (Number.isFinite(zVal) && zVal >= 0) {
            if (currentLayerIdx >= 0 && !layerHasMoves[currentLayerIdx]) {
              layerZs[currentLayerIdx] = zVal;
              if (currentLayerIdx > 0) {
                const diff = zVal - layerZs[currentLayerIdx - 1];
                if (diff > 0.02 && diff <= 1.0) {
                  layerHeightMm = Number(diff.toFixed(3));
                }
              }
            } else {
              pendingLayerZ = zVal;
            }
          }
        } else if (upperComment.startsWith('WIDTH:')) {
          const wVal = Number(comment.slice(6).trim());
          if (Number.isFinite(wVal) && wVal > 0.04 && wVal <= 5.0) {
            currentWidthMm = wVal;
          }
        } else if (upperComment.startsWith('HEIGHT:')) {
          const hVal = Number(comment.slice(7).trim());
          if (Number.isFinite(hVal) && hVal > 0.01 && hVal <= 2.0) {
            currentHeightMm = hVal;
            hasExplicitHeight = true;
          }
        } else if (upperComment.startsWith('TYPE:')) {
          if (!inEndGcode) {
            if (!hasLayerChangeMarkers) inModelPrint = true;
            sawTypeComment = true;
            currentFeature = mapCommentToFeature(comment.slice(5));
          }
        } else if (upperComment.startsWith('FEATURE:')) {
          if (!inEndGcode) {
            if (!hasLayerChangeMarkers) inModelPrint = true;
            sawTypeComment = true;
            currentFeature = mapCommentToFeature(comment.slice(8));
          }
        } else if (
          upperComment.startsWith('EXECUTABLE_BLOCK_END') ||
          upperComment.startsWith('END GCODE') ||
          upperComment.startsWith('END_GCODE')
        ) {
          if (hasAnyModelExtrusion) {
            inEndGcode = true;
          }
        } else if (comment.startsWith('printweb_coord_origin') && comment.includes('center')) {
          explicitOriginCenter = true;
        } else if (comment.startsWith('layer_height')) {
          const eq = comment.indexOf('=');
          if (eq >= 0) {
            const lh = Number(comment.slice(eq + 1).trim());
            if (Number.isFinite(lh) && lh > 0.02 && lh <= 1.2) {
              layerHeightMm = lh;
            }
          }
        } else if (comment.startsWith('printable_area') || comment.startsWith('bed_shape')) {
          const eq = comment.indexOf('=');
          if (eq >= 0) {
            const parsedArea = parsePrintableAreaInfo(comment.slice(eq + 1));
            if (parsedArea) printableArea = parsedArea;
          }
        }
      }
    }

    if (inEndGcode) continue;

    const codePart = (semiIdx >= 0 ? rawLine.slice(0, semiIdx) : rawLine).trim();
    if (!codePart) continue;

    // Extract command token
    const spaceIdx = codePart.search(/\s/);
    const cmd = (spaceIdx >= 0 ? codePart.slice(0, spaceIdx) : codePart).toUpperCase();

    if (cmd === 'G90') {
      absXYZ = true;
      continue;
    }
    if (cmd === 'G91') {
      absXYZ = false;
      continue;
    }
    if (cmd === 'M82') {
      absE = true;
      continue;
    }
    if (cmd === 'M83') {
      absE = false;
      continue;
    }
    if (cmd === 'M84' || cmd === 'M18') {
      if (hasAnyModelExtrusion) {
        inEndGcode = true;
      }
      continue;
    }

    if (cmd === 'M104') {
      if (hasAnyModelExtrusion) {
        const sMatch = /\bS(-?\d+(?:\.\d+)?)/i.exec(codePart);
        if (sMatch && Number(sMatch[1]) <= 0) {
          inEndGcode = true;
        }
      }
      continue;
    }

    if (cmd !== 'G0' && cmd !== 'G1' && cmd !== 'G2' && cmd !== 'G3' && cmd !== 'G92') {
      continue;
    }

    let hasX = false;
    let hasY = false;
    let hasZ = false;
    let hasE = false;
    let hasF = false;
    let hasI = false;
    let hasJ = false;
    let valX = 0;
    let valY = 0;
    let valZ = 0;
    let valE = 0;
    let valF = 0;
    let valI = 0;
    let valJ = 0;

    let i = spaceIdx >= 0 ? spaceIdx + 1 : codePart.length;
    const cLen = codePart.length;
    while (i < cLen) {
      while (i < cLen && codePart.charCodeAt(i) <= 32) i++;
      if (i >= cLen) break;
      const letter = codePart[i].toUpperCase();
      i++;
      const numStart = i;
      while (i < cLen && codePart.charCodeAt(i) > 32) i++;
      const num = Number(codePart.slice(numStart, i));
      if (!Number.isFinite(num)) continue;
      if (letter === 'X') {
        hasX = true;
        valX = num;
      } else if (letter === 'Y') {
        hasY = true;
        valY = num;
      } else if (letter === 'Z') {
        hasZ = true;
        valZ = num;
      } else if (letter === 'E') {
        hasE = true;
        valE = num;
      } else if (letter === 'F') {
        hasF = true;
        valF = num;
      } else if (letter === 'I') {
        hasI = true;
        valI = num;
      } else if (letter === 'J') {
        hasJ = true;
        valJ = num;
      }
    }

    if (cmd === 'G92') {
      if (hasX) curX = valX;
      if (hasY) curY = valY;
      if (hasZ) curZ = valZ;
      if (hasE) curE = valE;
      continue;
    }

    if (hasF && valF > 0) {
      currentSpeedMmS = valF / 60;
    }

    const nextX = hasX ? (absXYZ ? valX : curX + valX) : curX;
    const nextY = hasY ? (absXYZ ? valY : curY + valY) : curY;
    const nextZ = hasZ ? (absXYZ ? valZ : curZ + valZ) : curZ;

    let dE = 0;
    if (hasE) {
      if (absE) {
        dE = valE - curE;
        curE = valE;
      } else {
        dE = valE;
        curE += valE;
      }
    }

    const isExtrude = dE > 1e-6;
    const movedXY = hasX || hasY || hasI || hasJ;

    if ((cmd === 'G2' || cmd === 'G3') && movedXY) {
      const cx = curX + (hasI ? valI : 0);
      const cy = curY + (hasJ ? valJ : 0);
      const radius = Math.hypot(curX - cx, curY - cy);
      if (radius > 1e-4) {
        const startAng = Math.atan2(curY - cy, curX - cx);
        const endAng = Math.atan2(nextY - cy, nextX - cx);
        let delta = endAng - startAng;
        const ccw = cmd === 'G3';
        if (ccw) {
          if (delta <= 1e-6) delta += Math.PI * 2;
        } else {
          if (delta >= -1e-6) delta -= Math.PI * 2;
        }
        const arcLen = Math.abs(delta) * radius;
        const steps = Math.max(4, Math.min(36, Math.ceil(arcLen / 0.6)));
        let ax = curX;
        let ay = curY;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const ang = startAng + delta * t;
          const bx = s === steps ? nextX : cx + radius * Math.cos(ang);
          const by = s === steps ? nextY : cy + radius * Math.sin(ang);
          const bz = curZ + (nextZ - curZ) * t;
          pushSegment(ax, ay, bx, by, bz, isExtrude);
          ax = bx;
          ay = by;
        }
      } else if (hasX || hasY) {
        pushSegment(curX, curY, nextX, nextY, nextZ, isExtrude);
      }
    } else if (movedXY && (Math.abs(nextX - curX) > 1e-4 || Math.abs(nextY - curY) > 1e-4)) {
      pushSegment(curX, curY, nextX, nextY, nextZ, isExtrude);
    }

    curX = nextX;
    curY = nextY;
    curZ = nextZ;
  }

  // Determine XY centering offset onto Print-Web's centered build plate [-bedX/2, +bedX/2]
  let offsetX = 0;
  let offsetY = 0;
  if (!explicitOriginCenter) {
    if (printableArea) {
      offsetX = -printableArea.centerX;
      offsetY = -printableArea.centerY;
    } else {
      const refMinX = Number.isFinite(postTypeMinX) ? postTypeMinX : anyExtMinX;
      const refMaxX = Number.isFinite(postTypeMaxX) ? postTypeMaxX : anyExtMaxX;
      const refMinY = Number.isFinite(postTypeMinY) ? postTypeMinY : anyExtMinY;
      const refMaxY = Number.isFinite(postTypeMaxY) ? postTypeMaxY : anyExtMaxY;

      if (Number.isFinite(refMinX) && Number.isFinite(refMaxX)) {
        const cx = 0.5 * (refMinX + refMaxX);
        const cy = 0.5 * (refMinY + refMaxY);
        const distToCentered = Math.hypot(cx - expectedPosX, cy - expectedPosY);
        const distToFrontLeft = Math.hypot(
          cx - (expectedPosX + bedX * 0.5),
          cy - (expectedPosY + bedY * 0.5)
        );
        if (
          (refMinX >= -2 && refMinY >= -2 && (refMaxX > bedX * 0.5 + 1 || refMaxY > bedY * 0.5 + 1)) ||
          distToFrontLeft + 5 < distToCentered
        ) {
          offsetX = -bedX * 0.5;
          offsetY = -bedY * 0.5;
        }
      }
    }
  }

  // Filter out-of-bed purge/wipe moves once centered bed bounds are known
  const halfBedX =
    (printableArea ? 0.5 * (printableArea.maxX - printableArea.minX) : bedX * 0.5) +
    BED_FILTER_MARGIN_MM;
  const halfBedY =
    (printableArea ? 0.5 * (printableArea.maxY - printableArea.minY) : bedY * 0.5) +
    BED_FILTER_MARGIN_MM;

  const filteredSegments: RawSegment[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const sx0 = seg.x0 + offsetX;
    const sy0 = seg.y0 + offsetY;
    const sx1 = seg.x1 + offsetX;
    const sy1 = seg.y1 + offsetY;
    if (
      sx0 < -halfBedX ||
      sx0 > halfBedX ||
      sx1 < -halfBedX ||
      sx1 > halfBedX ||
      sy0 < -halfBedY ||
      sy0 > halfBedY ||
      sy1 < -halfBedY ||
      sy1 > halfBedY ||
      seg.z < -0.1
    ) {
      continue;
    }
    filteredSegments.push(seg);
  }

  if (filteredSegments.length === 0) {
    return {
      layerCount: 0,
      layerHeightMm,
      layers: [],
      presentFeatures: [],
      featureSegmentCounts: createZeroFeatureCounts(),
      featureStats: createZeroFeatureStats(),
      speedRange: { minMmS: 0, maxMmS: 0 },
      totalExtrusionSegments: 0,
      totalTravelSegments: 0,
      extrusionSegmentsByFeature: createEmptyFeatureFloatMap(),
      extrusionPropsByFeature: createEmptyFeatureFloatMap(),
      travelSegments: new Float32Array(0),
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
    };
  }

  // Group surviving segments by their original layerIdx, dropping any empty layers
  const layerBuckets = new Map<number, RawSegment[]>();
  const orderedLayerIndices: number[] = [];
  for (let i = 0; i < filteredSegments.length; i++) {
    const seg = filteredSegments[i];
    let bucket = layerBuckets.get(seg.layerIdx);
    if (!bucket) {
      bucket = [];
      layerBuckets.set(seg.layerIdx, bucket);
      orderedLayerIndices.push(seg.layerIdx);
    }
    bucket.push(seg);
  }

  const featureCounts = createZeroFeatureCounts();
  const featureLengths = createZeroFeatureCounts();
  let travelCount = 0;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const finalLayers: ParsedLayerMeta[] = [];

  for (let li = 0; li < orderedLayerIndices.length; li++) {
    const origLayerIdx = orderedLayerIndices[li];
    const segs = layerBuckets.get(origLayerIdx)!;
    const startByFeature = { ...featureCounts };
    const travelStart = travelCount;
    const moveCount = segs.length;
    const moveKinds = new Uint8Array(moveCount);
    const moveEndXY = new Float32Array(moveCount * 2);

    for (let m = 0; m < moveCount; m++) {
      const seg = segs[m];
      const sx0 = seg.x0 + offsetX;
      const sy0 = seg.y0 + offsetY;
      const sx1 = seg.x1 + offsetX;
      const sy1 = seg.y1 + offsetY;

      moveKinds[m] = seg.featureIdx;
      moveEndXY[m * 2] = sx1;
      moveEndXY[m * 2 + 1] = sy1;

      if (seg.isTravel) {
        travelCount++;
      } else {
        const feat = GCODE_FEATURE_ORDER[seg.featureIdx];
        featureCounts[feat]++;
        featureLengths[feat] += seg.lengthMm;

        if (sx0 < minX) minX = sx0;
        if (sx0 > maxX) maxX = sx0;
        if (sx1 < minX) minX = sx1;
        if (sx1 > maxX) maxX = sx1;
        if (sy0 < minY) minY = sy0;
        if (sy0 > maxY) maxY = sy0;
        if (sy1 < minY) minY = sy1;
        if (sy1 > maxY) maxY = sy1;
        if (seg.zBot < minZ) minZ = seg.zBot;
        if (seg.z > maxZ) maxZ = seg.z;
      }
    }

    finalLayers.push({
      z: layerZs[origLayerIdx],
      moveCount,
      startByFeature,
      endByFeature: { ...featureCounts },
      travelStart,
      travelEnd: travelCount,
      moveKinds,
      moveEndXY,
      startX: segs[0].x0 + offsetX,
      startY: segs[0].y0 + offsetY,
    });
  }

  const extrusionSegmentsByFeature: Record<GcodeFeatureType, Float32Array> = {
    outer_wall: new Float32Array(featureCounts.outer_wall * 7),
    inner_wall: new Float32Array(featureCounts.inner_wall * 7),
    sparse_infill: new Float32Array(featureCounts.sparse_infill * 7),
    solid_infill: new Float32Array(featureCounts.solid_infill * 7),
    overhang_bridge: new Float32Array(featureCounts.overhang_bridge * 7),
    support: new Float32Array(featureCounts.support * 7),
    skirt_brim: new Float32Array(featureCounts.skirt_brim * 7),
    other: new Float32Array(featureCounts.other * 7),
  };

  const extrusionPropsByFeature: Record<GcodeFeatureType, Float32Array> = {
    outer_wall: new Float32Array(featureCounts.outer_wall * 3),
    inner_wall: new Float32Array(featureCounts.inner_wall * 3),
    sparse_infill: new Float32Array(featureCounts.sparse_infill * 3),
    solid_infill: new Float32Array(featureCounts.solid_infill * 3),
    overhang_bridge: new Float32Array(featureCounts.overhang_bridge * 3),
    support: new Float32Array(featureCounts.support * 3),
    skirt_brim: new Float32Array(featureCounts.skirt_brim * 3),
    other: new Float32Array(featureCounts.other * 3),
  };

  const writeOffsets = createZeroFeatureCounts();
  const travelSegments = new Float32Array(travelCount * 6);
  let travelOffset = 0;

  for (let i = 0; i < filteredSegments.length; i++) {
    const seg = filteredSegments[i];
    const x0 = seg.x0 + offsetX;
    const y0 = seg.y0 + offsetY;
    const x1 = seg.x1 + offsetX;
    const y1 = seg.y1 + offsetY;

    if (seg.isTravel) {
      travelSegments[travelOffset++] = x0;
      travelSegments[travelOffset++] = y0;
      travelSegments[travelOffset++] = seg.z;
      travelSegments[travelOffset++] = x1;
      travelSegments[travelOffset++] = y1;
      travelSegments[travelOffset++] = seg.z;
    } else {
      const feat = GCODE_FEATURE_ORDER[seg.featureIdx];
      const idx = writeOffsets[feat];
      const segBuf = extrusionSegmentsByFeature[feat];
      let w = idx * 7;
      segBuf[w++] = x0;
      segBuf[w++] = y0;
      segBuf[w++] = seg.z;
      segBuf[w++] = x1;
      segBuf[w++] = y1;
      segBuf[w++] = seg.z;
      segBuf[w] = seg.zBot;

      const propBuf = extrusionPropsByFeature[feat];
      let pw = idx * 3;
      propBuf[pw++] = seg.widthMm;
      propBuf[pw++] = seg.heightMm;
      propBuf[pw] = seg.speedMmS;

      writeOffsets[feat]++;
    }
  }

  const presentFeatures = GCODE_FEATURE_ORDER.filter((f) => featureCounts[f] > 0);
  const totalExtrusionSegments = presentFeatures.reduce((sum, f) => sum + featureCounts[f], 0);
  const totalLengthMm = presentFeatures.reduce((sum, f) => sum + featureLengths[f], 0);

  const featureStats = createZeroFeatureStats();
  for (const f of GCODE_FEATURE_ORDER) {
    const lenMm = featureLengths[f];
    featureStats[f] = {
      segmentCount: featureCounts[f],
      lengthMm: Number(lenMm.toFixed(2)),
      sharePct: totalLengthMm > 0 ? Number(((lenMm / totalLengthMm) * 100).toFixed(2)) : 0,
    };
  }

  const speedRange = computeSpeedRange(filteredSegments);

  return {
    layerCount: finalLayers.length,
    layerHeightMm,
    layers: finalLayers,
    presentFeatures,
    featureSegmentCounts: featureCounts,
    featureStats,
    speedRange,
    totalExtrusionSegments,
    totalTravelSegments: travelCount,
    extrusionSegmentsByFeature,
    extrusionPropsByFeature,
    travelSegments,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
      maxZ: Number.isFinite(maxZ) ? maxZ : 0,
    },
  };
}

/**
 * Unit 3D filament bead prism (hexagonal cross-section + closed end caps).
 * Local coords:
 *   x = t along [0, 1] (start -> end)
 *   y = u across [-0.5, +0.5] (scaled by aWidth)
 *   z = v vertical [-1.0, 0.0] (scaled by aHeight, 0 = top, -1 = bottom)
 */
const BEAD_CROSS_SECTION: ReadonlyArray<readonly [number, number]> = [
  [0.5, -0.5],
  [0.32, 0.0],
  [-0.32, 0.0],
  [-0.5, -0.5],
  [-0.32, -1.0],
  [0.32, -1.0],
];

function createUnitBeadAttributes(): {
  position: THREE.BufferAttribute;
  normal: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
} {
  // 12 side vertices (6 at t=0, 6 at t=1) + 12 end-cap vertices (6 at t=0, 6 at t=1) = 24 vertices
  const nRing = BEAD_CROSS_SECTION.length;
  const vertCount = nRing * 4;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);

  for (let end = 0; end < 2; end++) {
    const t = end;
    for (let k = 0; k < nRing; k++) {
      const [u, v] = BEAD_CROSS_SECTION[k];
      const sideVertIdx = end * nRing + k;
      const so = sideVertIdx * 3;
      positions[so] = t;
      positions[so + 1] = u;
      positions[so + 2] = v;

      // Smooth radial normal in cross-section plane (u, v + 0.5)
      const nu = u;
      const nv = v + 0.5;
      const nLen = Math.hypot(nu, nv) || 1;
      normals[so] = 0;
      normals[so + 1] = nu / nLen;
      normals[so + 2] = nv / nLen;

      // End-cap vertices with flat tangent normals
      const capVertIdx = nRing * 2 + end * nRing + k;
      const co = capVertIdx * 3;
      positions[co] = t;
      positions[co + 1] = u;
      positions[co + 2] = v;
      normals[co] = end === 0 ? -1 : 1;
      normals[co + 1] = 0;
      normals[co + 2] = 0;
    }
  }

  const indices: number[] = [];
  // Side quads (6 faces * 2 triangles = 12 triangles)
  for (let k = 0; k < nRing; k++) {
    const n = (k + 1) % nRing;
    const k0 = k;
    const n0 = n;
    const k1 = nRing + k;
    const n1 = nRing + n;
    indices.push(k0, n0, k1, n0, n1, k1);
  }

  // Start cap (t=0, outward normal -tangent)
  const sBase = nRing * 2;
  for (let k = 1; k < nRing - 1; k++) {
    indices.push(sBase, sBase + k + 1, sBase + k);
  }

  // End cap (t=1, outward normal +tangent)
  const eBase = nRing * 3;
  for (let k = 1; k < nRing - 1; k++) {
    indices.push(eBase, eBase + k, eBase + k + 1);
  }

  return {
    position: new THREE.BufferAttribute(positions, 3),
    normal: new THREE.BufferAttribute(normals, 3),
    index: new THREE.BufferAttribute(new Uint16Array(indices), 1),
  };
}

const BEAD_VERTEX_SHADER = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aWidth;
attribute float aHeight;
attribute float aSpeed;

uniform float uColorMode;
uniform vec3 uBaseColor;
uniform float uMinSpeed;
uniform float uMaxSpeed;

varying vec3 vColor;
varying vec3 vWorldNormal;
varying float vVerticalT;

vec3 thermalSpeedColor(float speedVal) {
  float span = max(0.0, uMaxSpeed - uMinSpeed);
  float t = span < 0.5 ? 0.5 : clamp((speedVal - uMinSpeed) / span, 0.0, 1.0);
  float x = t * 4.0;
  vec3 c0 = vec3(0.10, 0.35, 0.95);
  vec3 c1 = vec3(0.02, 0.78, 0.92);
  vec3 c2 = vec3(0.14, 0.80, 0.32);
  vec3 c3 = vec3(0.98, 0.82, 0.08);
  vec3 c4 = vec3(0.94, 0.20, 0.16);
  vec3 srgb;
  if (x < 1.0) {
    srgb = mix(c0, c1, x);
  } else if (x < 2.0) {
    srgb = mix(c1, c2, x - 1.0);
  } else if (x < 3.0) {
    srgb = mix(c2, c3, x - 2.0);
  } else {
    srgb = mix(c3, c4, x - 3.0);
  }
  return pow(srgb, vec3(2.2));
}

void main() {
  vec3 delta = aEnd - aStart;
  float segLen = length(delta);
  vec3 tangent = segLen > 1e-5 ? delta / segLen : vec3(1.0, 0.0, 0.0);

  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  float sideLen = length(side);
  side = sideLen > 1e-5 ? side / sideLen : vec3(0.0, 1.0, 0.0);
  vec3 localUp = cross(tangent, side);

  // Subtle corner overlap so acute bends join solidly without miter gaps
  float capExtend = min(aWidth * 0.16, segLen * 0.35);
  vec3 spinePos = mix(aStart - tangent * capExtend, aEnd + tangent * capExtend, position.x);
  vec3 worldPos = spinePos + side * (position.y * aWidth) + localUp * (position.z * aHeight);

  // Scale normal by inverse cross-section dimensions for accurate shading
  vec3 rawN = tangent * normal.x + side * (normal.y / max(aWidth, 0.05)) + localUp * (normal.z / max(aHeight, 0.02));
  float nLen = length(rawN);
  vWorldNormal = normalize((modelMatrix * vec4(nLen > 1e-5 ? rawN / nLen : localUp, 0.0)).xyz);

  vVerticalT = 1.0 + position.z; // 1.0 at top of bead, 0.0 at bottom
  vColor = uColorMode > 1.5 ? thermalSpeedColor(aSpeed) : uBaseColor;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
}
`;

const BEAD_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying vec3 vWorldNormal;
varying float vVerticalT;

void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 keyDir = normalize(vec3(0.45, -0.49, 0.78));
  vec3 rimDir = normalize(vec3(-0.62, 0.62, 0.46));
  vec3 fillDir = normalize(vec3(-0.52, -0.46, 0.35));

  float keyDiff = max(dot(n, keyDir), 0.0);
  float rimDiff = max(dot(n, rimDir), 0.0);
  float fillDiff = max(dot(n, fillDir), 0.0);
  float hemi = 0.5 + 0.5 * n.z;

  // Vertical bead crevice shading gives crisp OrcaSlicer layer-line contrast
  float layerCrevice = mix(0.76, 1.04, clamp(vVerticalT, 0.0, 1.0));
  vec3 lighting =
    mix(vec3(0.26, 0.28, 0.33), vec3(0.56, 0.58, 0.62), hemi) +
    vec3(0.68) * keyDiff +
    vec3(0.18, 0.21, 0.26) * rimDiff +
    vec3(0.16) * fillDiff;

  gl_FragColor = vec4(vColor * lighting * layerCrevice, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function colorModeToFloat(mode: PreviewColorMode): number {
  if (mode === 'filament') return 1.0;
  if (mode === 'speed') return 2.0;
  return 0.0;
}

function buildInstancedBeadGeometry(
  packed: Float32Array,
  props: Float32Array | undefined,
  segCount: number
): THREE.InstancedBufferGeometry {
  const unit = createUnitBeadAttributes();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', unit.position);
  geometry.setAttribute('normal', unit.normal);
  geometry.setIndex(unit.index);

  const starts = new Float32Array(segCount * 3);
  const ends = new Float32Array(segCount * 3);
  const widths = new Float32Array(segCount);
  const heights = new Float32Array(segCount);
  const speeds = new Float32Array(segCount);

  for (let s = 0; s < segCount; s++) {
    const pBase = s * 7;
    const o3 = s * 3;
    const zTop = packed[pBase + 2];
    const zBot = packed[pBase + 6];

    starts[o3] = packed[pBase];
    starts[o3 + 1] = packed[pBase + 1];
    starts[o3 + 2] = zTop;

    ends[o3] = packed[pBase + 3];
    ends[o3 + 1] = packed[pBase + 4];
    ends[o3 + 2] = packed[pBase + 5];

    if (props && props.length >= (s + 1) * 3) {
      widths[s] = props[o3];
      heights[s] = props[o3 + 1];
      speeds[s] = props[o3 + 2];
    } else {
      widths[s] = DEFAULT_EXTRUSION_WIDTH_MM;
      heights[s] = Math.max(0.02, zTop - zBot);
      speeds[s] = DEFAULT_SPEED_MM_S;
    }
  }

  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(starts, 3));
  geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(ends, 3));
  geometry.setAttribute('aWidth', new THREE.InstancedBufferAttribute(widths, 1));
  geometry.setAttribute('aHeight', new THREE.InstancedBufferAttribute(heights, 1));
  geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speeds, 1));
  geometry.instanceCount = segCount;

  return geometry;
}

interface FeatureRenderEntry {
  feature: GcodeFeatureType;
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  totalSegments: number;
}

export class GcodePreviewRenderer {
  readonly group: THREE.Group;

  private parsed: ParsedGcode | null = null;
  private featureEntries = new Map<GcodeFeatureType, FeatureRenderEntry>();
  private travelLines: THREE.LineSegments | null = null;
  private nozzleGroup: THREE.Group;
  private colorMode: PreviewColorMode = 'line-type';
  private filamentColor = '#00A7D9';
  private hiddenFeatures = new Set<GcodeFeatureType>();
  private showTravels = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'GcodePreviewGroup';

    // Brass nozzle indicator (tip pointing down onto the active toolpath coordinate)
    this.nozzleGroup = new THREE.Group();
    this.nozzleGroup.visible = false;

    const tipGeo = new THREE.ConeGeometry(1.5, 4.2, 16);
    tipGeo.rotateX(-Math.PI / 2); // Tip points toward -Z
    tipGeo.translate(0, 0, 2.1);
    const tipMat = new THREE.MeshStandardMaterial({
      color: '#F59E0B',
      roughness: 0.35,
      metalness: 0.65,
    });
    const tipMesh = new THREE.Mesh(tipGeo, tipMat);

    const bodyGeo = new THREE.CylinderGeometry(2.1, 1.5, 3.6, 16);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.translate(0, 0, 6.0);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: '#334155',
      roughness: 0.45,
      metalness: 0.4,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);

    this.nozzleGroup.add(tipMesh, bodyMesh);
    this.group.add(this.nozzleGroup);
  }

  load(parsed: ParsedGcode, filamentColor: string): void {
    this.clearToolpaths();
    this.parsed = parsed;
    this.filamentColor = filamentColor || '#00A7D9';

    const minSpeed = parsed.speedRange?.minMmS ?? 0;
    const maxSpeed = parsed.speedRange?.maxMmS ?? 0;

    for (const feature of parsed.presentFeatures) {
      const segCount = parsed.featureSegmentCounts[feature];
      if (segCount <= 0) continue;
      const packed = parsed.extrusionSegmentsByFeature[feature];
      const props = parsed.extrusionPropsByFeature?.[feature];

      const geometry = buildInstancedBeadGeometry(packed, props, segCount);
      const baseColor = new THREE.Color(
        this.colorMode === 'filament' ? this.filamentColor : FEATURE_COLORS[feature]
      );

      const material = new THREE.ShaderMaterial({
        vertexShader: BEAD_VERTEX_SHADER,
        fragmentShader: BEAD_FRAGMENT_SHADER,
        uniforms: {
          uColorMode: { value: colorModeToFloat(this.colorMode) },
          uBaseColor: { value: baseColor },
          uMinSpeed: { value: minSpeed },
          uMaxSpeed: { value: maxSpeed },
        },
        side: THREE.FrontSide,
        toneMapped: true,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.visible = !this.hiddenFeatures.has(feature);
      this.group.add(mesh);

      this.featureEntries.set(feature, {
        feature,
        mesh,
        geometry,
        material,
        totalSegments: segCount,
      });
    }

    if (parsed.totalTravelSegments > 0) {
      const travelGeo = new THREE.BufferGeometry();
      travelGeo.setAttribute('position', new THREE.BufferAttribute(parsed.travelSegments, 3));
      const travelMat = new THREE.LineBasicMaterial({
        color: TRAVEL_COLOR,
        transparent: true,
        opacity: 0.55,
      });
      const travelLines = new THREE.LineSegments(travelGeo, travelMat);
      travelLines.frustumCulled = false;
      travelLines.visible = this.showTravels;
      this.group.add(travelLines);
      this.travelLines = travelLines;
    }

    if (parsed.layerCount > 0) {
      const lastIdx = parsed.layerCount - 1;
      this.setRange(lastIdx, parsed.layers[lastIdx].moveCount);
    }
  }

  setRange(layerIndex: number, moveIndex: number, showNozzle = false): void {
    if (!this.parsed || this.parsed.layerCount === 0) return;
    const clampedLayerIdx = Math.max(0, Math.min(this.parsed.layerCount - 1, layerIndex));
    const layer = this.parsed.layers[clampedLayerIdx];
    const clampedMove = Math.max(0, Math.min(layer.moveCount, moveIndex));

    if (clampedMove >= layer.moveCount) {
      // O(1) full layer instanceCount update
      for (const [feat, entry] of this.featureEntries.entries()) {
        entry.geometry.instanceCount = layer.endByFeature[feat];
      }
      if (this.travelLines) {
        const tCount = layer.travelEnd - layer.travelStart;
        this.travelLines.geometry.setDrawRange(layer.travelStart * 2, tCount * 2);
      }
      if (showNozzle && layer.moveCount > 0) {
        const nx = layer.moveEndXY[(layer.moveCount - 1) * 2];
        const ny = layer.moveEndXY[(layer.moveCount - 1) * 2 + 1];
        this.nozzleGroup.position.set(nx, ny, layer.z);
        this.nozzleGroup.visible = true;
      } else {
        this.nozzleGroup.visible = false;
      }
      return;
    }

    // Partial layer scrub: accumulate feature counts across 0 .. clampedMove - 1
    const activeCounts = new Uint32Array(GCODE_FEATURE_ORDER.length);
    let activeTravels = 0;
    for (let m = 0; m < clampedMove; m++) {
      const mk = layer.moveKinds[m];
      if (mk === TRAVEL_KIND) {
        activeTravels++;
      } else {
        activeCounts[mk]++;
      }
    }

    for (const [feat, entry] of this.featureEntries.entries()) {
      const fIdx = FEATURE_TO_INDEX[feat];
      entry.geometry.instanceCount = layer.startByFeature[feat] + activeCounts[fIdx];
    }

    if (this.travelLines) {
      this.travelLines.geometry.setDrawRange(layer.travelStart * 2, activeTravels * 2);
    }

    if (clampedMove > 0) {
      const nx = layer.moveEndXY[(clampedMove - 1) * 2];
      const ny = layer.moveEndXY[(clampedMove - 1) * 2 + 1];
      this.nozzleGroup.position.set(nx, ny, layer.z);
    } else {
      this.nozzleGroup.position.set(layer.startX, layer.startY, layer.z);
    }
    this.nozzleGroup.visible = true;
  }

  setColorMode(mode: PreviewColorMode, filamentColor: string): void {
    this.colorMode = mode;
    this.filamentColor = filamentColor || '#00A7D9';
    const modeFloat = colorModeToFloat(mode);

    for (const [feat, entry] of this.featureEntries.entries()) {
      entry.material.uniforms.uColorMode.value = modeFloat;
      entry.material.uniforms.uBaseColor.value.set(
        mode === 'filament' ? this.filamentColor : FEATURE_COLORS[feat]
      );
    }
  }

  setVisibleFeatures(hiddenFeatures: Set<GcodeFeatureType>, showTravels: boolean): void {
    this.hiddenFeatures = new Set(hiddenFeatures);
    this.showTravels = showTravels;
    for (const [feat, entry] of this.featureEntries.entries()) {
      entry.mesh.visible = !hiddenFeatures.has(feat);
    }
    if (this.travelLines) {
      this.travelLines.visible = showTravels;
    }
  }

  clear(): void {
    this.clearToolpaths();
  }

  private clearToolpaths(): void {
    for (const entry of this.featureEntries.values()) {
      this.group.remove(entry.mesh);
      entry.geometry.dispose();
      entry.material.dispose();
    }
    this.featureEntries.clear();

    if (this.travelLines) {
      this.group.remove(this.travelLines);
      this.travelLines.geometry.dispose();
      (this.travelLines.material as THREE.Material).dispose();
      this.travelLines = null;
    }
    this.nozzleGroup.visible = false;
    this.parsed = null;
  }

  dispose(): void {
    this.clearToolpaths();
    for (const child of [...this.nozzleGroup.children]) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }
}
