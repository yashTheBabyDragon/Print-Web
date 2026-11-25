import * as THREE from 'three';
import { ConvexHull, Face, HalfEdge } from 'three/examples/jsm/math/ConvexHull.js';

interface CachedHullCluster {
  normal: THREE.Vector3;
  points: THREE.Vector3[];
  rawArea: number;
}

interface CandidatePlane2D {
  normal: THREE.Vector3;
  toPlaneQuat: THREE.Quaternion;
  polygon: THREE.Vector2[];
  zMean: number;
  area: number;
}

interface FacetEntry {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  outline: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  localNormal: THREE.Vector3;
}

// Upstream OrcaSlicer LayOnFace.cpp thresholds
const NORMAL_MATCH_EPS = 0.001; // std::abs(this_normal(i) - normal(i)) < 0.001
const MINIMAL_AREA_MM2 = 5.0; // LayOnFace.cpp:107
const MINIMAL_SIDE_MM = 1.0; // LayOnFace.cpp:108
const MINIMAL_ANGLE_RAD = (1.0 * Math.PI) / 180.0; // LayOnFace.cpp:109
const MINIMAL_ANGLE_COS = Math.cos(MINIMAL_ANGLE_RAD);
const MAX_RENDERED_PLANES = 254; // GLGizmoFlatten.cpp:197

// Upstream OrcaSlicer GLGizmoFlatten.cpp rounding & lift constants
const CORNER_ROUND_ITERATIONS = 10; // k = 10
const CORNER_ROUND_AGGRESSIVITY = 0.2; // aggressivity = 0.2f
const OUTLINE_SHRINK_KEEP = 0.9; // 0.9f * vertex + 0.1f * centroid
const SURFACE_LIFT_MM = 0.1; // b(2) += 0.1f

const MAX_HULL_INPUT_POINTS = 10000;
const MAX_PRE_DEDUP_SAMPLE = 40000;

const IDLE_COLOR = 0xf8fafc;
const IDLE_OPACITY = 0.72;
const IDLE_OUTLINE_COLOR = 0x64748b;
const IDLE_OUTLINE_OPACITY = 0.6;

const HOVER_COLOR = 0x00a7d9;
const HOVER_OPACITY = 0.86;
const HOVER_OUTLINE_COLOR = 0x005f80;
const HOVER_OUTLINE_OPACITY = 0.95;

function quantizePointKey(p: THREE.Vector3, step: number): string {
  const qx = Math.round(p.x / step);
  const qy = Math.round(p.y / step);
  const qz = Math.round(p.z / step);
  return `${qx},${qy},${qz}`;
}

function deduplicatePoints(points: THREE.Vector3[], step: number): THREE.Vector3[] {
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = quantizePointKey(p, step);
    if (!seen.has(key)) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

/**
 * 2D Andrew's monotone chain convex hull returning strictly convex CCW vertices.
 */
function convexHull2D(points: THREE.Vector2[]): THREE.Vector2[] {
  if (points.length < 3) return [];

  // Deduplicate within 1e-5 mm and sort lexicographically by (x, y)
  const dedupMap = new Map<string, THREE.Vector2>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, p);
    }
  }

  const sorted = Array.from(dedupMap.values()).sort((a, b) =>
    a.x !== b.x ? a.x - b.x : a.y - b.y
  );
  if (sorted.length < 3) return [];

  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: THREE.Vector2[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-8) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: THREE.Vector2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-8) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function shoelaceArea2D(polygon: THREE.Vector2[]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];
    sum += curr.x * next.y - next.x * curr.y;
  }
  return 0.5 * Math.abs(sum);
}

/**
 * Exact port of OrcaSlicer GLGizmoFlatten::update_planes() 2D inset & corner rounding
 * (`src/slic3r/GUI/Gizmos/GLGizmoFlatten.cpp:203-246`).
 */
function smoothAndInsetPolygon(polygon: THREE.Vector2[]): THREE.Vector2[] {
  const n = polygon.length;
  if (n < 3) return polygon;

  // Shrink slightly toward centroid so overlay pads stay cleanly inside part edges
  const centroid = new THREE.Vector2(0, 0);
  for (let j = 0; j < n; j++) {
    centroid.add(polygon[j]);
  }
  centroid.divideScalar(n);

  const shrunk: THREE.Vector2[] = new Array(n);
  for (let j = 0; j < n; j++) {
    shrunk[j] = polygon[j]
      .clone()
      .multiplyScalar(OUTLINE_SHRINK_KEEP)
      .addScaledVector(centroid, 1 - OUTLINE_SHRINK_KEEP);
  }

  const k = CORNER_ROUND_ITERATIONS;
  const aggressivity = CORNER_ROUND_AGGRESSIVITY;
  const totalOut = 2 * k * n;
  const pointsOut: THREE.Vector2[] = new Array(totalOut);
  const neighbours: Array<[number, number]> = new Array(n);

  for (let j = 0; j < n; j++) {
    pointsOut[j * 2 * k] = shrunk[j].clone();
    const first = j * 2 * k - k < 0 ? (n - 1) * 2 * k + k : j * 2 * k - k;
    const second = j * 2 * k + k;
    neighbours[j] = [first, second];
  }

  for (let i = 0; i < k; i++) {
    for (let j = 0; j < n; j++) {
      if (i === 0) {
        const nextIdx = j === n - 1 ? 0 : (j + 1) * 2 * k;
        pointsOut[j * 2 * k + k] = pointsOut[j * 2 * k]
          .clone()
          .add(pointsOut[nextIdx])
          .multiplyScalar(0.5);
      } else {
        const r = 0.2 + (0.3 / (k - 1)) * i;
        const [nf, ns] = neighbours[j];
        pointsOut[nf] = pointsOut[j * 2 * k]
          .clone()
          .multiplyScalar(r)
          .addScaledVector(pointsOut[nf - 1], 1 - r);
        pointsOut[ns] = pointsOut[j * 2 * k]
          .clone()
          .multiplyScalar(r)
          .addScaledVector(pointsOut[ns + 1], 1 - r);
      }
    }

    for (let j = 0; j < n; j++) {
      const [nf, ns] = neighbours[j];
      const mid = pointsOut[nf].clone().add(pointsOut[ns]).multiplyScalar(0.5);
      pointsOut[2 * k * j] = pointsOut[2 * k * j]
        .clone()
        .multiplyScalar(1 - aggressivity)
        .addScaledVector(mid, aggressivity);
    }

    for (let j = 0; j < n; j++) {
      neighbours[j][0] += 1;
      neighbours[j][1] -= 1;
    }
  }

  return pointsOut;
}

function buildBoxHullClusters(points: THREE.Vector3[]): {
  clusters: CachedHullCluster[];
  hullVertices: THREE.Vector3[];
} {
  const box = new THREE.Box3();
  for (let i = 0; i < points.length; i++) {
    box.expandByPoint(points[i]);
  }
  if (box.isEmpty()) return { clusters: [], hullVertices: [] };

  const { min, max } = box;
  const dx = max.x - min.x;
  const dy = max.y - min.y;
  const dz = max.z - min.z;
  const eps = 1e-4;

  const p000 = new THREE.Vector3(min.x, min.y, min.z);
  const p100 = new THREE.Vector3(max.x, min.y, min.z);
  const p110 = new THREE.Vector3(max.x, max.y, min.z);
  const p010 = new THREE.Vector3(min.x, max.y, min.z);
  const p001 = new THREE.Vector3(min.x, min.y, max.z);
  const p101 = new THREE.Vector3(max.x, min.y, max.z);
  const p111 = new THREE.Vector3(max.x, max.y, max.z);
  const p011 = new THREE.Vector3(min.x, max.y, max.z);

  const clusters: CachedHullCluster[] = [];
  if (dx > eps && dy > eps) {
    clusters.push({
      normal: new THREE.Vector3(0, 0, 1),
      points: [p001.clone(), p101.clone(), p111.clone(), p011.clone()],
      rawArea: dx * dy,
    });
    clusters.push({
      normal: new THREE.Vector3(0, 0, -1),
      points: [p000.clone(), p010.clone(), p110.clone(), p100.clone()],
      rawArea: dx * dy,
    });
  }
  if (dx > eps && dz > eps) {
    clusters.push({
      normal: new THREE.Vector3(0, -1, 0),
      points: [p000.clone(), p100.clone(), p101.clone(), p001.clone()],
      rawArea: dx * dz,
    });
    clusters.push({
      normal: new THREE.Vector3(0, 1, 0),
      points: [p010.clone(), p011.clone(), p111.clone(), p110.clone()],
      rawArea: dx * dz,
    });
  }
  if (dy > eps && dz > eps) {
    clusters.push({
      normal: new THREE.Vector3(1, 0, 0),
      points: [p100.clone(), p110.clone(), p111.clone(), p101.clone()],
      rawArea: dy * dz,
    });
    clusters.push({
      normal: new THREE.Vector3(-1, 0, 0),
      points: [p000.clone(), p001.clone(), p011.clone(), p010.clone()],
      rawArea: dy * dz,
    });
  }

  return {
    clusters,
    hullVertices: [p000, p100, p110, p010, p001, p101, p111, p011],
  };
}

/**
 * OrcaSlicer-faithful "Lay on Face" (F) 3D resting-plane overlay.
 *
 * Ports upstream `libslic3r/LayOnFace.cpp` and `GUI/Gizmos/GLGizmoFlatten.cpp`:
 * 1. Builds the 3D convex hull and clusters topologically adjacent facets sharing
 *    the same outward normal within `0.001` per axis.
 * 2. Projects clusters to printed world mm at current scale, computes their 2D
 *    convex outline, and drops sliver facets (`< 5 mm²`, triangle side `< 1 mm`,
 *    inner angle `< 1°`).
 * 3. Insets outlines by 10%, rounds corners (`k = 10`, `aggressivity = 0.2`),
 *    lifts `+0.1 mm` outward, and limits rendering to the top `254` planes.
 */
export class LayOnFaceOverlay {
  readonly group: THREE.Group;

  private entries: FacetEntry[] = [];
  private entryByObject = new Map<THREE.Object3D, FacetEntry>();
  private hoveredEntry: FacetEntry | null = null;
  private cachedClusters: CachedHullCluster[] = [];
  private hullLocalVertices: THREE.Vector3[] = [];
  private currentScale = 1.0;
  private _facetCount = 0;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'LayOnFaceOverlay';
  }

  get facetCount(): number {
    return this._facetCount;
  }

  /**
   * Returns exact 3D convex hull vertices in mesh-local coordinates (before `localOffset`),
   * or `[]` if point striding was needed so `BuildPlate3D` falls back to all exact vertices.
   */
  getHullLocalVertices(): THREE.Vector3[] {
    return this.hullLocalVertices;
  }

  /**
   * Extracts hull normal clusters from `geometry` (shifted by `localOffset`) and builds
   * OrcaSlicer rounded resting pads for the initial printed `scale`.
   */
  buildFromGeometry(
    geometry: THREE.BufferGeometry,
    localOffset: THREE.Vector3 = new THREE.Vector3(),
    scale = 1.0
  ): void {
    this.dispose();

    const posAttr = geometry.getAttribute('position');
    if (!posAttr || posAttr.count < 3) {
      return;
    }

    // Compute raw bounds using scalar reads first so huge STLs never allocate millions of Vector3s
    const rawBox = new THREE.Box3();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i) + localOffset.x;
      const y = posAttr.getY(i) + localOffset.y;
      const z = posAttr.getZ(i) + localOffset.z;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    rawBox.min.set(minX, minY, minZ);
    rawBox.max.set(maxX, maxY, maxZ);

    const size = new THREE.Vector3();
    rawBox.getSize(size);
    const diag = size.length();
    if (diag <= 1e-6) {
      return;
    }

    let wasStrided = false;
    const preStride =
      posAttr.count > MAX_PRE_DEDUP_SAMPLE
        ? Math.ceil(posAttr.count / MAX_PRE_DEDUP_SAMPLE)
        : 1;
    if (preStride > 1) {
      wasStrided = true;
    }
    const rawPoints: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i += preStride) {
      rawPoints.push(
        new THREE.Vector3(
          posAttr.getX(i) + localOffset.x,
          posAttr.getY(i) + localOffset.y,
          posAttr.getZ(i) + localOffset.z
        )
      );
    }

    const quantStep = Math.max(1e-4, Math.min(0.01, diag * 1e-4));
    let uniquePoints = deduplicatePoints(rawPoints, quantStep);

    if (uniquePoints.length > MAX_HULL_INPUT_POINTS) {
      const coarser = deduplicatePoints(uniquePoints, Math.max(quantStep, diag * 5e-4));
      if (coarser.length <= MAX_HULL_INPUT_POINTS) {
        uniquePoints = coarser;
      } else {
        wasStrided = true;
        const stride = Math.ceil(uniquePoints.length / MAX_HULL_INPUT_POINTS);
        const sampled: THREE.Vector3[] = [];
        for (let i = 0; i < uniquePoints.length; i += stride) {
          sampled.push(uniquePoints[i]);
        }
        uniquePoints = sampled;
      }
    }

    const { clusters, hullVertices } = this.computeHullClusters(uniquePoints);
    if (clusters.length === 0) {
      const fallback = buildBoxHullClusters(uniquePoints);
      this.cachedClusters = fallback.clusters;
      this.hullLocalVertices = !wasStrided
        ? fallback.hullVertices.map((v) => v.clone().sub(localOffset))
        : [];
    } else {
      this.cachedClusters = clusters;
      // Only expose hull vertices for exact World Box3 bounds when no input vertices were strided.
      this.hullLocalVertices = !wasStrided
        ? hullVertices.map((v) => v.clone().sub(localOffset))
        : [];
    }

    this.cachedClusters.sort((a, b) => b.rawArea - a.rawArea);
    this.rebuildForScale(scale);
  }

  /**
   * Re-evaluates area/side/angle filters and builds rounded overlay pads for printed `scale`
   * without recomputing the 3D convex hull.
   */
  rebuildForScale(scale: number): void {
    this.clearRenderedEntries();
    this.currentScale = Math.max(0.01, scale);
    if (this.cachedClusters.length === 0) return;

    const upZ = new THREE.Vector3(0, 0, 1);
    const xAxis = new THREE.Vector3(1, 0, 0);

    const passed: CandidatePlane2D[] = [];
    const fallbackPool: CandidatePlane2D[] = [];

    for (let cIdx = 0; cIdx < this.cachedClusters.length; cIdx++) {
      const cluster = this.cachedClusters[cIdx];
      const normal = cluster.normal.clone().normalize();
      if (normal.lengthSq() <= 1e-8) continue;

      const toPlaneQuat = new THREE.Quaternion();
      if (normal.dot(upZ) < -1 + 1e-9) {
        toPlaneQuat.setFromAxisAngle(xAxis, Math.PI);
      } else {
        toPlaneQuat.setFromUnitVectors(normal, upZ);
      }

      const projected2D: THREE.Vector2[] = new Array(cluster.points.length);
      let zSum = 0;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < cluster.points.length; i++) {
        tmp.copy(cluster.points[i]).multiplyScalar(this.currentScale).applyQuaternion(toPlaneQuat);
        projected2D[i] = new THREE.Vector2(tmp.x, tmp.y);
        zSum += tmp.z;
      }
      const zMean = zSum / cluster.points.length;

      const polygon = convexHull2D(projected2D);
      if (polygon.length < 3) continue;

      const area = shoelaceArea2D(polygon);
      if (area <= 1e-6) continue;

      const candidate: CandidatePlane2D = {
        normal,
        toPlaneQuat,
        polygon,
        zMean,
        area,
      };
      fallbackPool.push(candidate);

      // LayOnFace.cpp:156-160 triangle minimal side check
      if (polygon.length === 3) {
        const d01 = polygon[0].distanceTo(polygon[1]);
        const d12 = polygon[1].distanceTo(polygon[2]);
        const d20 = polygon[2].distanceTo(polygon[0]);
        if (d01 < MINIMAL_SIDE_MM || d12 < MINIMAL_SIDE_MM || d20 < MINIMAL_SIDE_MM) {
          continue;
        }
      }

      // LayOnFace.cpp:198-200 area check
      if (area < MINIMAL_AREA_MM2) {
        continue;
      }

      // LayOnFace.cpp:202-215 inner angle check
      let badAngle = false;
      const pCount = polygon.length;
      const ePrev = new THREE.Vector2();
      const eNext = new THREE.Vector2();
      for (let i = 0; i < pCount; i++) {
        const prec = polygon[i === 0 ? pCount - 1 : i - 1];
        const curr = polygon[i];
        const next = polygon[i === pCount - 1 ? 0 : i + 1];
        ePrev.subVectors(prec, curr);
        eNext.subVectors(next, curr);
        if (ePrev.lengthSq() <= 1e-12 || eNext.lengthSq() <= 1e-12) {
          badAngle = true;
          break;
        }
        ePrev.normalize();
        eNext.normalize();
        if (ePrev.dot(eNext) > MINIMAL_ANGLE_COS) {
          badAngle = true;
          break;
        }
      }
      if (badAngle) continue;

      passed.push(candidate);
    }

    let finalPlanes: CandidatePlane2D[];
    if (passed.length > 0) {
      passed.sort((a, b) => b.area - a.area);
      finalPlanes = passed.slice(0, MAX_RENDERED_PLANES);
    } else {
      fallbackPool.sort((a, b) => b.area - a.area);
      finalPlanes = fallbackPool.slice(0, 6);
    }

    for (let i = 0; i < finalPlanes.length; i++) {
      const entry = this.createFacetEntry(finalPlanes[i], this.currentScale);
      if (!entry) continue;
      this.entries.push(entry);
      this.entryByObject.set(entry.mesh, entry);
      this.group.add(entry.mesh);
      this.group.add(entry.outline);
    }

    this._facetCount = this.entries.length;
  }

  private computeHullClusters(points: THREE.Vector3[]): {
    clusters: CachedHullCluster[];
    hullVertices: THREE.Vector3[];
  } {
    if (points.length < 4) {
      return { clusters: [], hullVertices: [] };
    }

    const hull = new ConvexHull();
    try {
      hull.setFromPoints(points);
    } catch {
      return { clusters: [], hullVertices: [] };
    }

    const faces = hull.faces;
    if (!faces || faces.length === 0) {
      return { clusters: [], hullVertices: [] };
    }

    const faceCount = faces.length;
    const faceToIndex = new Map<Face, number>();
    const faceNormals: THREE.Vector3[] = new Array(faceCount);
    const hullVertMap = new Map<string, THREE.Vector3>();

    for (let i = 0; i < faceCount; i++) {
      const f = faces[i];
      faceToIndex.set(f, i);
      const n = f.normal.clone();
      if (n.lengthSq() > 1e-12) n.normalize();
      faceNormals[i] = n;
    }

    const visited = new Uint8Array(faceCount);
    const stack: number[] = [];
    const clusters: CachedHullCluster[] = [];

    for (let seedIdx = 0; seedIdx < faceCount; seedIdx++) {
      if (visited[seedIdx]) continue;
      const seedFace = faces[seedIdx];
      const seedNormal = faceNormals[seedIdx];
      if (!seedFace || seedNormal.lengthSq() <= 1e-8) {
        visited[seedIdx] = 1;
        continue;
      }

      visited[seedIdx] = 1;
      stack.length = 0;
      stack.push(seedIdx);

      const clusterPoints: THREE.Vector3[] = [];
      const weightedNormal = new THREE.Vector3();
      let rawArea = 0;

      while (stack.length > 0) {
        const curIdx = stack.pop()!;
        const curFace = faces[curIdx];
        const curNormal = faceNormals[curIdx];

        if (
          curIdx !== seedIdx &&
          (visited[curIdx] ||
            Math.abs(curNormal.x - seedNormal.x) >= NORMAL_MATCH_EPS ||
            Math.abs(curNormal.y - seedNormal.y) >= NORMAL_MATCH_EPS ||
            Math.abs(curNormal.z - seedNormal.z) >= NORMAL_MATCH_EPS)
        ) {
          continue;
        }

        visited[curIdx] = 1;
        const fArea = Math.max(curFace.area, 1e-8);
        rawArea += curFace.area;
        weightedNormal.addScaledVector(curNormal, fArea);

        // Walk the face's half-edge loop to gather vertices and unvisited twin neighbors
        let e: HalfEdge | null = curFace.edge;
        let guard = 0;
        if (e) {
          const startEdge = e;
          do {
            const vPoint = e.vertex.point.clone();
            clusterPoints.push(vPoint);
            hullVertMap.set(quantizePointKey(vPoint, 1e-4), vPoint);

            const twinFace = e.twin?.face;
            if (twinFace) {
              const neighborIdx = faceToIndex.get(twinFace);
              if (neighborIdx !== undefined && !visited[neighborIdx]) {
                stack.push(neighborIdx);
              }
            }
            e = e.next;
            guard++;
          } while (e && e !== startEdge && guard < 64);
        }
      }

      if (clusterPoints.length >= 3 && rawArea > 1e-8) {
        const avgNormal =
          weightedNormal.lengthSq() > 1e-12
            ? weightedNormal.normalize()
            : seedNormal.clone();
        clusters.push({
          normal: avgNormal,
          points: clusterPoints,
          rawArea,
        });
      }
    }

    return {
      clusters,
      hullVertices: Array.from(hullVertMap.values()),
    };
  }

  private createFacetEntry(plane: CandidatePlane2D, scale: number): FacetEntry | null {
    const rounded2D = smoothAndInsetPolygon(plane.polygon);
    const vCount = rounded2D.length;
    if (vCount < 3) return null;

    const invQuat = plane.toPlaneQuat.clone().invert();
    const invScale = 1.0 / scale;
    const zPlane = plane.zMean + SURFACE_LIFT_MM;

    const vertices3D: THREE.Vector3[] = new Array(vCount);
    for (let i = 0; i < vCount; i++) {
      vertices3D[i] = new THREE.Vector3(rounded2D[i].x, rounded2D[i].y, zPlane)
        .applyQuaternion(invQuat)
        .multiplyScalar(invScale);
    }

    // Verify CCW winding against outward normal in local space; flip order if inverted
    const ab = new THREE.Vector3().subVectors(vertices3D[1], vertices3D[0]);
    const ac = new THREE.Vector3().subVectors(vertices3D[2], vertices3D[0]);
    const triCross = new THREE.Vector3().crossVectors(ab, ac);
    if (triCross.dot(plane.normal) < 0) {
      vertices3D.reverse();
    }

    const triCount = vCount - 2;
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);
    const v0 = vertices3D[0];

    for (let i = 0; i < triCount; i++) {
      const v1 = vertices3D[i + 1];
      const v2 = vertices3D[i + 2];
      const base = i * 9;

      positions[base] = v0.x;
      positions[base + 1] = v0.y;
      positions[base + 2] = v0.z;

      positions[base + 3] = v1.x;
      positions[base + 4] = v1.y;
      positions[base + 5] = v1.z;

      positions[base + 6] = v2.x;
      positions[base + 7] = v2.y;
      positions[base + 8] = v2.z;

      for (let k = 0; k < 3; k++) {
        normals[base + k * 3] = plane.normal.x;
        normals[base + k * 3 + 1] = plane.normal.y;
        normals[base + k * 3 + 2] = plane.normal.z;
      }
    }

    const meshGeo = new THREE.BufferGeometry();
    meshGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    meshGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    const meshMat = new THREE.MeshBasicMaterial({
      color: IDLE_COLOR,
      transparent: true,
      opacity: IDLE_OPACITY,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(meshGeo, meshMat);
    mesh.renderOrder = 2;
    mesh.userData.localNormal = plane.normal.clone();

    const loopPositions = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) {
      loopPositions[i * 3] = vertices3D[i].x;
      loopPositions[i * 3 + 1] = vertices3D[i].y;
      loopPositions[i * 3 + 2] = vertices3D[i].z;
    }

    const outlineGeo = new THREE.BufferGeometry();
    outlineGeo.setAttribute('position', new THREE.BufferAttribute(loopPositions, 3));

    const outlineMat = new THREE.LineBasicMaterial({
      color: IDLE_OUTLINE_COLOR,
      transparent: true,
      opacity: IDLE_OUTLINE_OPACITY,
      toneMapped: false,
    });

    const outline = new THREE.LineLoop(outlineGeo, outlineMat);
    outline.renderOrder = 3;
    outline.raycast = () => {};

    return {
      mesh,
      outline,
      localNormal: plane.normal.clone(),
    };
  }

  /** Returns the clickable planar facet meshes for raycasting. */
  getPickables(): THREE.Object3D[] {
    return this.entries.map((entry) => entry.mesh);
  }

  /**
   * Returns a cloned outward unit normal in local overlay space if `obj`
   * belongs to this overlay, or `null` otherwise.
   */
  getFacetLocalNormal(obj: THREE.Object3D): THREE.Vector3 | null {
    const entry = this.entryByObject.get(obj);
    if (!entry) {
      return null;
    }
    return entry.localNormal.clone();
  }

  /** Highlights the hovered facet (or clears the highlight when `null`). */
  setHoveredObject(obj: THREE.Object3D | null): void {
    const nextEntry = obj ? (this.entryByObject.get(obj) ?? null) : null;
    if (this.hoveredEntry === nextEntry) {
      return;
    }

    if (this.hoveredEntry) {
      this.hoveredEntry.mesh.material.color.setHex(IDLE_COLOR);
      this.hoveredEntry.mesh.material.opacity = IDLE_OPACITY;
      this.hoveredEntry.outline.material.color.setHex(IDLE_OUTLINE_COLOR);
      this.hoveredEntry.outline.material.opacity = IDLE_OUTLINE_OPACITY;
    }

    this.hoveredEntry = nextEntry;

    if (this.hoveredEntry) {
      this.hoveredEntry.mesh.material.color.setHex(HOVER_COLOR);
      this.hoveredEntry.mesh.material.opacity = HOVER_OPACITY;
      this.hoveredEntry.outline.material.color.setHex(HOVER_OUTLINE_COLOR);
      this.hoveredEntry.outline.material.opacity = HOVER_OUTLINE_OPACITY;
    }
  }

  private clearRenderedEntries(): void {
    for (const entry of this.entries) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.outline.geometry.dispose();
      entry.outline.material.dispose();
    }
    this.entries = [];
    this.entryByObject.clear();
    this.hoveredEntry = null;
    this._facetCount = 0;
    this.group.clear();
  }

  /** Disposes all facet/outline geometries and clears cached hull data. */
  dispose(): void {
    this.clearRenderedEntries();
    this.cachedClusters = [];
    this.hullLocalVertices = [];
    this.currentScale = 1.0;
  }
}
