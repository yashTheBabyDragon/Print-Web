import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Compass,
  Crosshair,
  Eye,
  Layers,
  Loader2,
  Lock,
  Magnet,
  Maximize2,
  Minus,
  Move,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { api } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import {
  FEATURE_COLORS,
  GCODE_FEATURE_ORDER,
  GcodePreviewRenderer,
  parseGcode,
  TRAVEL_COLOR,
  type GcodeFeatureType,
  type ParsedGcode,
  type PreviewColorMode,
} from '../three/gcodePreview';
import { LayOnFaceOverlay } from '../three/layOnFaceOverlay';
import { UniformScaleGizmo } from '../three/uniformScaleGizmo';

export type WorkspaceMode = 'prepare' | 'preview';

export interface PreviewStatusState {
  loading: boolean;
  ready: boolean;
  error: string | null;
  layerCount: number;
}

export interface MeshTransformState {
  posX: number;
  posY: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  scale: number;
}

export interface BoundingDimensions {
  widthMm: number;
  depthMm: number;
  heightMm: number;
  outOfBounds: boolean;
}

interface BuildPlate3DProps {
  jobId: number | null;
  meshVersion: number;
  isVisible?: boolean;
  bedX: number;
  bedY: number;
  bedZ: number;
  filamentColor: string;
  transform: MeshTransformState;
  onTransformChange: (next: MeshTransformState) => void;
  onReorient?: () => void;
  reorienting?: boolean;
  onBoundsChange?: (bounds: BoundingDimensions) => void;
  onDropFile?: (file: File) => void;
  workspaceMode?: WorkspaceMode;
  onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  canPreview?: boolean;
  sliceVersion?: number;
  sliceStale?: boolean;
  onReSlice?: () => void;
  slicing?: boolean;
  onPreviewStateChange?: (state: PreviewStatusState) => void;
}

type ToolMode = 'move' | 'rotate' | 'scale' | 'snap';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const MIN_SCALE = 0.1;
const MAX_SCALE = 4.0;

function NumericInput({
  value,
  onCommit,
  step = 1,
  min,
  max,
  decimals = 1,
  className = '',
  ariaLabel,
}: {
  value: number;
  onCommit: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const formatVal = (v: number) =>
    decimals === 0 ? String(Math.round(v)) : String(Number(v.toFixed(decimals)));

  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(() => formatVal(value));

  useEffect(() => {
    if (!focused) {
      setDraft(formatVal(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, decimals]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextStr = e.target.value;
    setDraft(nextStr);
    const parsed = Number(nextStr);
    if (nextStr.trim() !== '' && Number.isFinite(parsed)) {
      if (min !== undefined && parsed < min) return;
      if (max !== undefined && parsed > max) return;
      onCommit(parsed);
    }
  };

  const handleBlur = () => {
    setFocused(false);
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed)) {
      let clamped = parsed;
      if (min !== undefined) clamped = Math.max(min, clamped);
      if (max !== undefined) clamped = Math.min(max, clamped);
      onCommit(clamped);
      setDraft(formatVal(clamped));
    } else {
      setDraft(formatVal(value));
    }
  };

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      aria-label={ariaLabel}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}

const _tmpBoxVec = new THREE.Vector3();
const MAX_EXACT_BOUNDS_VERTS = 25000;
const BOUNDS_SAMPLE_LIMIT = 12000;

function extractFastBoundsVertices(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count === 0) return [];

  const count = posAttr.count;
  if (count <= MAX_EXACT_BOUNDS_VERTS) {
    const seen = new Map<string, THREE.Vector3>();
    for (let i = 0; i < count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      if (!seen.has(key)) {
        seen.set(key, new THREE.Vector3(x, y, z));
      }
    }
    return Array.from(seen.values());
  }

  // 26 directional extrema (6 axes + 12 edge diagonals + 8 corner diagonals) preserve tight bounds on huge meshes
  const dirs: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0],
    [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
    [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
    [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
    [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
  ];
  const bestDot = new Float64Array(dirs.length).fill(-Infinity);
  const bestIdx = new Int32Array(dirs.length).fill(0);

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    for (let d = 0; d < dirs.length; d++) {
      const [dx, dy, dz] = dirs[d];
      const dot = x * dx + y * dy + z * dz;
      if (dot > bestDot[d]) {
        bestDot[d] = dot;
        bestIdx[d] = i;
      }
    }
  }

  const picked = new Set<number>();
  for (let d = 0; d < bestIdx.length; d++) {
    picked.add(bestIdx[d]);
  }
  const stride = Math.max(1, Math.floor(count / BOUNDS_SAMPLE_LIMIT));
  for (let i = 0; i < count; i += stride) {
    picked.add(i);
  }

  const out: THREE.Vector3[] = [];
  picked.forEach((idx) => {
    out.push(new THREE.Vector3(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx)));
  });
  return out;
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const meshLike = obj as THREE.Mesh | THREE.Line | THREE.LineSegments;
    if (meshLike.geometry && typeof meshLike.geometry.dispose === 'function') {
      meshLike.geometry.dispose();
    }
    const mat = meshLike.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) {
      for (const m of mat) m?.dispose();
    } else if (mat && typeof mat.dispose === 'function') {
      mat.dispose();
    }
  });
}

function computeExactWorldBox(
  mesh: THREE.Mesh,
  hullLocalVertices: THREE.Vector3[]
): THREE.Box3 {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const matrix = mesh.matrixWorld;

  if (hullLocalVertices.length > 0) {
    for (let i = 0; i < hullLocalVertices.length; i++) {
      _tmpBoxVec.copy(hullLocalVertices[i]).applyMatrix4(matrix);
      box.expandByPoint(_tmpBoxVec);
    }
    return box;
  }

  const posAttr = mesh.geometry.getAttribute('position');
  if (!posAttr) return box;
  for (let i = 0; i < posAttr.count; i++) {
    _tmpBoxVec.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
    box.expandByPoint(_tmpBoxVec);
  }
  return box;
}

export function BuildPlate3D({
  jobId,
  meshVersion,
  isVisible = true,
  bedX,
  bedY,
  bedZ,
  filamentColor,
  transform,
  onTransformChange,
  onReorient,
  reorienting = false,
  onBoundsChange,
  onDropFile,
  workspaceMode = 'prepare',
  onWorkspaceModeChange,
  canPreview = false,
  sliceVersion = 0,
  sliceStale = false,
  onReSlice,
  slicing = false,
  onPreviewStateChange,
}: BuildPlate3DProps) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const prepareTabId = useId();
  const previewTabId = useId();
  const prepareTabRef = useRef<HTMLButtonElement | null>(null);
  const previewTabRef = useRef<HTMLButtonElement | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const bedGroupRef = useRef<THREE.Group | null>(null);
  const volumeBoxRef = useRef<THREE.LineSegments | null>(null);
  const pivotGroupRef = useRef<THREE.Group | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const scaleGizmoRef = useRef<UniformScaleGizmo | null>(null);
  const layOverlayRef = useRef<LayOnFaceOverlay | null>(null);
  const gcodePreviewRef = useRef<GcodePreviewRenderer | null>(null);

  const transformRef = useRef(transform);
  transformRef.current = transform;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;
  const onPreviewStateChangeRef = useRef(onPreviewStateChange);
  onPreviewStateChangeRef.current = onPreviewStateChange;
  const workspaceModeRef = useRef<WorkspaceMode>(workspaceMode);
  workspaceModeRef.current = workspaceMode;
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 767px)').matches
  );
  const isMobileViewportRef = useRef(isMobileViewport);
  isMobileViewportRef.current = isMobileViewport;

  const bedDimsRef = useRef({ bedX, bedY, bedZ, theme });
  bedDimsRef.current = { bedX, bedY, bedZ, theme };

  const isDraggingGizmoRef = useRef(false);
  const lastBuiltScaleRef = useRef(1.0);
  const boundsVertsRef = useRef<THREE.Vector3[]>([]);
  const meshCenterOffsetRef = useRef(new THREE.Vector3());
  const layBuiltKeyRef = useRef<string | null>(null);
  const requestRenderRef = useRef<() => void>(() => {});
  const requestShadowUpdateRef = useRef<() => void>(() => {});

  const [activeTool, setActiveTool] = useState<ToolMode | null>('move');
  const activeToolRef = useRef<ToolMode | null>(activeTool);
  activeToolRef.current = activeTool;
  const [loadedMeshSeq, setLoadedMeshSeq] = useState(0);
  const [buildingLayOverlay, setBuildingLayOverlay] = useState(false);

  const [overlayOpen, setOverlayOpen] = useState(true);
  const [dragOverCanvas, setDragOverCanvas] = useState(false);
  const [facetCount, setFacetCount] = useState(0);
  const [minZMm, setMinZMm] = useState(0);

  const [loadingMesh, setLoadingMesh] = useState(false);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<BoundingDimensions>({
    widthMm: 0,
    depthMm: 0,
    heightMm: 0,
    outOfBounds: false,
  });

  // Preview state
  const [parsedGcode, setParsedGcode] = useState<ParsedGcode | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [currentLayer, setCurrentLayer] = useState(1);
  const [currentMove, setCurrentMove] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const [colorMode, setColorMode] = useState<PreviewColorMode>('line-type');
  const [hiddenFeatures, setHiddenFeatures] = useState<Set<GcodeFeatureType>>(() => new Set());
  const [showTravels, setShowTravels] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);

  const evaluateBoundsFromBox = useCallback((finalBox: THREE.Box3) => {
    if (finalBox.isEmpty()) return;
    const { bedX: bx, bedY: by, bedZ: bz, theme: curTheme } = bedDimsRef.current;
    const size = new THREE.Vector3();
    finalBox.getSize(size);
    setMinZMm(Number(finalBox.min.z.toFixed(3)));

    const eps = 0.05;
    const outOfBounds =
      finalBox.min.x < -bx / 2 - eps ||
      finalBox.max.x > bx / 2 + eps ||
      finalBox.min.y < -by / 2 - eps ||
      finalBox.max.y > by / 2 + eps ||
      finalBox.min.z < -eps ||
      finalBox.max.z > bz + eps;

    const nextBounds: BoundingDimensions = {
      widthMm: size.x,
      depthMm: size.y,
      heightMm: size.z,
      outOfBounds,
    };
    setBounds(nextBounds);
    onBoundsChangeRef.current?.(nextBounds);

    if (volumeBoxRef.current) {
      const mat = volumeBoxRef.current.material as THREE.LineBasicMaterial;
      mat.color.set(outOfBounds ? '#E11D48' : curTheme === 'dark' ? '#363A45' : '#C3C8D4');
      mat.opacity = outOfBounds ? 0.9 : 0.4;
    }
  }, []);

  const getExactMeshBox = useCallback((mesh: THREE.Mesh) => {
    const hullVerts = layOverlayRef.current?.getHullLocalVertices() ?? [];
    const verts = hullVerts.length > 0 ? hullVerts : boundsVertsRef.current;
    return computeExactWorldBox(mesh, verts);
  }, []);

  const syncPivotTransform = useCallback(
    (tr: MeshTransformState) => {
      if (isDraggingGizmoRef.current) return;
      const pivot = pivotGroupRef.current;
      const mesh = meshRef.current;
      if (!pivot || !mesh) return;

      const quat = new THREE.Quaternion(tr.quatX, tr.quatY, tr.quatZ, tr.quatW).normalize();
      pivot.quaternion.copy(quat);
      pivot.scale.setScalar(tr.scale);
      pivot.position.set(0, 0, 0);
      pivot.updateMatrixWorld(true);

      const box = getExactMeshBox(mesh);
      if (box.isEmpty()) return;

      const center = new THREE.Vector3();
      box.getCenter(center);

      pivot.position.set(tr.posX - center.x, tr.posY - center.y, -box.min.z);
      pivot.updateMatrixWorld(true);

      const finalBox = getExactMeshBox(mesh);
      evaluateBoundsFromBox(finalBox);

      if (
        activeToolRef.current === 'scale' &&
        scaleGizmoRef.current &&
        cameraRef.current &&
        scaleGizmoRef.current.group.visible
      ) {
        scaleGizmoRef.current.updateFromBox(finalBox, cameraRef.current);
      }

      requestShadowUpdateRef.current();
    },
    [evaluateBoundsFromBox, getExactMeshBox]
  );

  const configureGizmoForTool = useCallback((tool: ToolMode | null) => {
    const tc = transformControlsRef.current;
    const pivot = pivotGroupRef.current;
    const scaleGizmo = scaleGizmoRef.current;
    const layOverlay = layOverlayRef.current;
    const isPrepare = workspaceModeRef.current === 'prepare';
    const hasMesh = Boolean(pivot && meshRef.current && isPrepare);
    const effectiveTool = isMobileViewportRef.current ? null : tool;

    if (layOverlay) {
      layOverlay.group.visible = effectiveTool === 'snap' && hasMesh;
      if (!hasMesh || effectiveTool !== 'snap') {
        layOverlay.setHoveredObject(null);
      }
    }

    if (scaleGizmo) {
      if (isPrepare && effectiveTool === 'scale' && meshRef.current && pivot && cameraRef.current) {
        scaleGizmo.group.visible = true;
        pivot.updateMatrixWorld(true);
        const box = getExactMeshBox(meshRef.current);
        scaleGizmo.updateFromBox(box, cameraRef.current);
      } else {
        if (scaleGizmo.isDragging) {
          scaleGizmo.endDrag();
          isDraggingGizmoRef.current = false;
          if (controlsRef.current) {
            controlsRef.current.enabled = true;
          }
        }
        scaleGizmo.setHovered(false);
        scaleGizmo.group.visible = false;
      }
    }

    if (!tc) return;

    if (
      !hasMesh ||
      !pivot ||
      effectiveTool === null ||
      effectiveTool === 'snap' ||
      effectiveTool === 'scale'
    ) {
      tc.detach();
      return;
    }

    tc.attach(pivot);
    if (effectiveTool === 'move') {
      tc.setMode('translate');
      tc.setSpace('world');
      tc.showX = true;
      tc.showY = true;
      tc.showZ = false;
    } else if (effectiveTool === 'rotate') {
      tc.setMode('rotate');
      tc.setSpace('world');
      tc.showX = true;
      tc.showY = true;
      tc.showZ = true;
    }
    requestRenderRef.current();
  }, [getExactMeshBox]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const syncViewport = () => {
      isMobileViewportRef.current = mediaQuery.matches;
      setIsMobileViewport(mediaQuery.matches);
      configureGizmoForTool(activeToolRef.current);
    };
    syncViewport();
    mediaQuery.addEventListener('change', syncViewport);
    return () => mediaQuery.removeEventListener('change', syncViewport);
  }, [configureGizmoForTool]);

  // Initialize Three.js Scene + TransformControls once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const width = container.clientWidth || 900;
    const height = container.clientHeight || 600;

    // Native Z-up camera matching STL & OrcaSlicer
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.5, 4000);
    camera.up.set(0, 0, 1);
    camera.position.set(bedX * 0.92, -bedY * 1.12, Math.max(bedZ * 0.72, 165));
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 22);
    controls.minDistance = 40;
    controls.maxDistance = 1200;
    controls.maxPolarAngle = Math.PI * 0.492;
    controls.update();
    controlsRef.current = controls;

    // Clean neutral studio lighting
    const hemi = new THREE.HemisphereLight(0xf8fafc, 0x262932, 0.9);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(220, -240, 380);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 150;
    keyLight.shadow.camera.far = 850;
    const d = 240;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.00008;
    keyLight.shadow.normalBias = 0.04;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xdbeafe, 0.45);
    rimLight.position.set(-240, 240, 180);
    scene.add(rimLight);

    const fillLight = new THREE.DirectionalLight(0xe2e8f0, 0.4);
    fillLight.position.set(-180, -160, 120);
    scene.add(fillLight);

    const bedGroup = new THREE.Group();
    scene.add(bedGroup);
    bedGroupRef.current = bedGroup;

    const pivotGroup = new THREE.Group();
    pivotGroup.visible = workspaceModeRef.current === 'prepare';
    scene.add(pivotGroup);
    pivotGroupRef.current = pivotGroup;

    const gcodePreview = new GcodePreviewRenderer();
    gcodePreview.group.visible = workspaceModeRef.current === 'preview';
    scene.add(gcodePreview.group);
    gcodePreviewRef.current = gcodePreview;

    const layOverlay = new LayOnFaceOverlay();
    layOverlay.group.visible = false;
    pivotGroup.add(layOverlay.group);
    layOverlayRef.current = layOverlay;

    const scaleGizmo = new UniformScaleGizmo();
    scaleGizmo.group.visible = false;
    scene.add(scaleGizmo.group);
    scaleGizmoRef.current = scaleGizmo;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(0.85);
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    let animId = 0;
    let isDisposed = false;
    let isInRenderFrame = false;

    const renderFrame = () => {
      animId = 0;
      if (isDisposed) return;

      isInRenderFrame = true;
      const cameraMoved = controls.update();
      isInRenderFrame = false;

      if (
        workspaceModeRef.current === 'prepare' &&
        activeToolRef.current === 'scale' &&
        meshRef.current &&
        scaleGizmo.group.visible &&
        !scaleGizmo.isDragging
      ) {
        pivotGroup.updateMatrixWorld(true);
        const box = getExactMeshBox(meshRef.current);
        if (!box.isEmpty()) {
          scaleGizmo.updateFromBox(box, camera);
        }
      }

      renderer.render(scene, camera);

      if (cameraMoved || isDraggingGizmoRef.current || isPlayingRef.current) {
        requestRender();
      }
    };

    const requestRender = () => {
      if (isDisposed || animId !== 0) return;
      animId = requestAnimationFrame(renderFrame);
    };

    const requestShadowUpdate = () => {
      renderer.shadowMap.needsUpdate = true;
      requestRender();
    };

    requestRenderRef.current = requestRender;
    requestShadowUpdateRef.current = requestShadowUpdate;

    const onControlsChange = () => {
      if (!isInRenderFrame) {
        requestRender();
      }
    };
    controls.addEventListener('change', onControlsChange);
    transformControls.addEventListener('change', requestRender);

    const onDraggingChanged = (event: { value: unknown }) => {
      const isDragging = Boolean(event.value);
      isDraggingGizmoRef.current = isDragging;
      controls.enabled = !isDragging;
      if (!isDragging) {
        syncPivotTransform(transformRef.current);
      } else {
        requestRender();
      }
    };

    const onObjectChange = () => {
      if (!meshRef.current) return;
      const tool = activeToolRef.current;

      if (tool === 'move') {
        pivotGroup.updateMatrixWorld(true);
        const box = getExactMeshBox(meshRef.current);
        if (box.isEmpty()) return;
        if (Math.abs(box.min.z) > 1e-5) {
          pivotGroup.position.z += -box.min.z;
          pivotGroup.updateMatrixWorld(true);
        }
        const finalBox = getExactMeshBox(meshRef.current);
        const center = new THREE.Vector3();
        finalBox.getCenter(center);
        evaluateBoundsFromBox(finalBox);
        requestShadowUpdate();
        onTransformChangeRef.current({
          ...transformRef.current,
          posX: Number(center.x.toFixed(1)),
          posY: Number(center.y.toFixed(1)),
        });
      } else if (tool === 'rotate') {
        pivotGroup.updateMatrixWorld(true);
        const box = getExactMeshBox(meshRef.current);
        if (box.isEmpty()) return;
        if (Math.abs(box.min.z) > 1e-5) {
          pivotGroup.position.z += -box.min.z;
          pivotGroup.updateMatrixWorld(true);
        }
        const finalBox = getExactMeshBox(meshRef.current);
        const center = new THREE.Vector3();
        finalBox.getCenter(center);
        evaluateBoundsFromBox(finalBox);
        requestShadowUpdate();
        const q = pivotGroup.quaternion.clone().normalize();
        onTransformChangeRef.current({
          ...transformRef.current,
          posX: Number(center.x.toFixed(2)),
          posY: Number(center.y.toFixed(2)),
          quatX: q.x,
          quatY: q.y,
          quatZ: q.z,
          quatW: q.w,
        });
      }
    };

    transformControls.addEventListener('dragging-changed', onDraggingChanged);
    transformControls.addEventListener('objectChange', onObjectChange);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const bedPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    let isDraggingMesh = false;
    const dragOffset = new THREE.Vector2();
    let snapDownPos: { x: number; y: number } | null = null;
    let prevScaleHover = false;
    let prevSnapHoverObj: THREE.Object3D | null = null;

    const updatePointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const alignLocalNormalToBed = (localNormal: THREE.Vector3) => {
      const cur = transformRef.current;
      const curQuat = new THREE.Quaternion(cur.quatX, cur.quatY, cur.quatZ, cur.quatW).normalize();
      const worldNormal = localNormal.clone().applyQuaternion(curQuat).normalize();
      const down = new THREE.Vector3(0, 0, -1);

      const alignQuat = new THREE.Quaternion();
      const dot = worldNormal.dot(down);
      if (dot < -1 + 1e-9) {
        alignQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
      } else if (dot < 1 - 1e-9) {
        alignQuat.setFromUnitVectors(worldNormal, down);
      }

      const nextQuat = alignQuat.multiply(curQuat).normalize();
      onTransformChangeRef.current({
        ...cur,
        quatX: nextQuat.x,
        quatY: nextQuat.y,
        quatZ: nextQuat.z,
        quatW: nextQuat.w,
      });
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (
        isMobileViewportRef.current ||
        ev.button !== 0 ||
        !meshRef.current ||
        workspaceModeRef.current !== 'prepare'
      ) {
        return;
      }

      if (activeToolRef.current === 'scale') {
        updatePointer(ev);
        raycaster.setFromCamera(pointer, camera);
        pivotGroup.updateMatrixWorld(true);
        const box = getExactMeshBox(meshRef.current);
        if (scaleGizmo.beginDrag(raycaster, camera, box, transformRef.current.scale)) {
          ev.stopPropagation();
          controls.enabled = false;
          isDraggingGizmoRef.current = true;
          renderer.domElement.style.cursor = 'grabbing';
          requestRender();
        }
        return;
      }

      if (activeToolRef.current === 'snap' && layOverlay.group.visible) {
        snapDownPos = { x: ev.clientX, y: ev.clientY };
        return;
      }

      if (transformControls.dragging || transformControls.axis !== null) return;

      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(meshRef.current, false);
      if (hits.length === 0) return;

      if (activeToolRef.current === 'move') {
        const planeHit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(bedPlane, planeHit)) {
          isDraggingMesh = true;
          controls.enabled = false;
          dragOffset.set(
            transformRef.current.posX - planeHit.x,
            transformRef.current.posY - planeHit.y
          );
          renderer.domElement.style.cursor = 'grabbing';
        }
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (
        isMobileViewportRef.current ||
        !meshRef.current ||
        workspaceModeRef.current !== 'prepare'
      ) {
        if (renderer.domElement.style.cursor !== 'default') {
          renderer.domElement.style.cursor = 'default';
        }
        return;
      }

      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);

      if (scaleGizmo.isDragging) {
        const nextScale = scaleGizmo.updateDrag(raycaster);
        if (nextScale !== null) {
          const cur = transformRef.current;
          const quat = new THREE.Quaternion(cur.quatX, cur.quatY, cur.quatZ, cur.quatW).normalize();
          pivotGroup.quaternion.copy(quat);
          pivotGroup.scale.setScalar(nextScale);
          pivotGroup.position.set(0, 0, 0);
          pivotGroup.updateMatrixWorld(true);

          const box = getExactMeshBox(meshRef.current);
          if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            box.getCenter(center);
            pivotGroup.position.set(cur.posX - center.x, cur.posY - center.y, -box.min.z);
            pivotGroup.updateMatrixWorld(true);

            const finalBox = getExactMeshBox(meshRef.current);
            evaluateBoundsFromBox(finalBox);
            scaleGizmo.updateFromBox(finalBox, camera);
            requestShadowUpdate();
            onTransformChangeRef.current({
              ...cur,
              scale: Number(nextScale.toFixed(4)),
            });
          }
        }
        renderer.domElement.style.cursor = 'grabbing';
        return;
      }

      if (transformControls.dragging || transformControls.axis !== null) {
        renderer.domElement.style.cursor = transformControls.dragging ? 'grabbing' : 'pointer';
        return;
      }

      if (isDraggingMesh) {
        const planeHit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(bedPlane, planeHit)) {
          const nextX = Number((planeHit.x + dragOffset.x).toFixed(1));
          const nextY = Number((planeHit.y + dragOffset.y).toFixed(1));
          onTransformChangeRef.current({
            ...transformRef.current,
            posX: nextX,
            posY: nextY,
          });
        }
        return;
      }

      if (activeToolRef.current === 'scale') {
        const hitGizmo = scaleGizmo.isHit(raycaster);
        scaleGizmo.setHovered(hitGizmo);
        if (hitGizmo !== prevScaleHover) {
          prevScaleHover = hitGizmo;
          requestRender();
        }
        renderer.domElement.style.cursor = hitGizmo ? 'grab' : 'default';
        return;
      }

      if (activeToolRef.current === 'snap' && layOverlay.group.visible) {
        const hits = raycaster.intersectObjects(layOverlay.getPickables(), false);
        const firstHit = hits[0];
        const nextHoverObj =
          firstHit && layOverlay.getFacetLocalNormal(firstHit.object) !== null
            ? firstHit.object
            : null;
        if (nextHoverObj !== prevSnapHoverObj) {
          prevSnapHoverObj = nextHoverObj;
          layOverlay.setHoveredObject(nextHoverObj);
          requestRender();
        }
        renderer.domElement.style.cursor = nextHoverObj ? 'pointer' : 'default';
        return;
      }

      const hits = raycaster.intersectObject(meshRef.current, false);
      if (hits.length > 0 && activeToolRef.current === 'move') {
        renderer.domElement.style.cursor = 'grab';
      } else {
        renderer.domElement.style.cursor = 'default';
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (scaleGizmo.isDragging) {
        scaleGizmo.endDrag();
        controls.enabled = !transformControls.dragging;
        isDraggingGizmoRef.current = false;
        renderer.domElement.style.cursor = 'default';
        syncPivotTransform(transformRef.current);
      }

      if (snapDownPos !== null) {
        const dx = ev.clientX - snapDownPos.x;
        const dy = ev.clientY - snapDownPos.y;
        snapDownPos = null;
        if (
          ev.button === 0 &&
          Math.hypot(dx, dy) < 6 &&
          activeToolRef.current === 'snap' &&
          layOverlay.group.visible &&
          meshRef.current
        ) {
          updatePointer(ev);
          raycaster.setFromCamera(pointer, camera);
          const hits = raycaster.intersectObjects(layOverlay.getPickables(), false);
          if (hits.length > 0) {
            const localNormal = layOverlay.getFacetLocalNormal(hits[0].object);
            if (localNormal) {
              alignLocalNormalToBed(localNormal);
              layOverlay.setHoveredObject(null);
            }
          }
        }
      }

      if (isDraggingMesh) {
        isDraggingMesh = false;
        controls.enabled = !transformControls.dragging;
        renderer.domElement.style.cursor = 'default';
        requestRender();
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    requestRender();

    const observer = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        requestRender();
      }
    });
    observer.observe(container);

    return () => {
      isDisposed = true;
      cancelAnimationFrame(animId);
      requestRenderRef.current = () => {};
      requestShadowUpdateRef.current = () => {};
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      controls.removeEventListener('change', onControlsChange);
      transformControls.removeEventListener('change', requestRender);
      transformControls.removeEventListener('dragging-changed', onDraggingChanged);
      transformControls.removeEventListener('objectChange', onObjectChange);
      transformControls.detach();
      scene.remove(transformControls.getHelper());
      transformControls.dispose();
      scaleGizmo.endDrag();
      scene.remove(scaleGizmo.group);
      scaleGizmo.dispose();
      scaleGizmoRef.current = null;
      pivotGroup.remove(layOverlay.group);
      layOverlay.dispose();
      layOverlayRef.current = null;
      if (meshRef.current) {
        pivotGroup.remove(meshRef.current);
        meshRef.current.geometry.dispose();
        (meshRef.current.material as THREE.Material).dispose();
        meshRef.current = null;
      }
      boundsVertsRef.current = [];
      disposeObject3D(bedGroup);
      bedGroup.clear();
      scene.remove(gcodePreview.group);
      gcodePreview.dispose();
      gcodePreviewRef.current = null;
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild bed plate & wireframe whenever bed dimensions or theme change
  useEffect(() => {
    const scene = sceneRef.current;
    const bedGroup = bedGroupRef.current;
    if (!scene || !bedGroup) return;

    scene.background = new THREE.Color(theme === 'dark' ? '#111317' : '#ECEEF2');

    while (bedGroup.children.length > 0) {
      const child = bedGroup.children.pop()!;
      bedGroup.remove(child);
      disposeObject3D(child);
    }

    // Matte build plate surface
    const plateGeo = new THREE.PlaneGeometry(bedX, bedY);
    const plateMat = new THREE.MeshStandardMaterial({
      color: theme === 'dark' ? '#1A1D24' : '#FFFFFF',
      roughness: 0.9,
      metalness: 0.05,
    });
    const plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.position.set(0, 0, -0.04);
    plateMesh.receiveShadow = true;
    bedGroup.add(plateMesh);

    // Subtle 10mm grid
    const maxDim = Math.max(bedX, bedY);
    const divisions = Math.max(10, Math.round(maxDim / 10));
    const grid = new THREE.GridHelper(
      maxDim,
      divisions,
      theme === 'dark' ? 0x3b4252 : 0xcbd2df,
      theme === 'dark' ? 0x242833 : 0xe5e8ef
    );
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.005;
    grid.scale.set(bedX / maxDim, 1, bedY / maxDim);
    bedGroup.add(grid);

    // Subtle plate perimeter hairline
    const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(bedX, bedY, 0.2));
    const borderMat = new THREE.LineBasicMaterial({
      color: theme === 'dark' ? 0x3b4252 : 0xb8c0ce,
      transparent: true,
      opacity: 0.85,
    });
    const border = new THREE.LineSegments(borderGeo, borderMat);
    border.position.set(0, 0, -0.1);
    bedGroup.add(border);

    // Build volume wireframe box [0, bedZ]
    const volGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(bedX, bedY, bedZ));
    const volMat = new THREE.LineBasicMaterial({
      color: theme === 'dark' ? '#363A45' : '#C3C8D4',
      transparent: true,
      opacity: 0.4,
    });
    const volBox = new THREE.LineSegments(volGeo, volMat);
    volBox.position.set(0, 0, bedZ / 2);
    bedGroup.add(volBox);
    volumeBoxRef.current = volBox;

    // Quiet front-edge indicator in Print-Web cyan
    const frontGeo = new THREE.BoxGeometry(Math.min(48, bedX * 0.2), 1.8, 0.6);
    const frontMat = new THREE.MeshBasicMaterial({ color: 0x00a7d9 });
    const frontBar = new THREE.Mesh(frontGeo, frontMat);
    frontBar.position.set(0, -bedY / 2 - 2, 0.3);
    bedGroup.add(frontBar);

    syncPivotTransform(transformRef.current);
    requestShadowUpdateRef.current();
  }, [bedX, bedY, bedZ, theme, syncPivotTransform]);

  // Load STL mesh into pivotGroup whenever jobId or meshVersion changes
  useEffect(() => {
    const pivot = pivotGroupRef.current;
    if (!pivot) return;

    transformControlsRef.current?.detach();
    if (scaleGizmoRef.current) {
      scaleGizmoRef.current.endDrag();
      scaleGizmoRef.current.group.visible = false;
    }
    layOverlayRef.current?.dispose();
    layBuiltKeyRef.current = null;
    boundsVertsRef.current = [];
    setFacetCount(0);
    setBuildingLayOverlay(false);

    if (meshRef.current) {
      pivot.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }
    setMeshError(null);

    if (!jobId) {
      const zeroBounds = { widthMm: 0, depthMm: 0, heightMm: 0, outOfBounds: false };
      setBounds(zeroBounds);
      onBoundsChangeRef.current?.(zeroBounds);
      requestShadowUpdateRef.current();
      return;
    }

    let cancelled = false;
    setLoadingMesh(true);

    (async () => {
      try {
        const buffer = await api.fetchJobMeshBuffer(jobId);
        if (cancelled) return;

        const loader = new STLLoader();
        const geometry = loader.parse(buffer);
        if (!geometry.getAttribute('normal')) {
          geometry.computeVertexNormals();
        }
        geometry.computeBoundingBox();

        const rawBox = geometry.boundingBox!;
        const rawCenter = new THREE.Vector3();
        rawBox.getCenter(rawCenter);
        meshCenterOffsetRef.current.set(-rawCenter.x, -rawCenter.y, -rawCenter.z);
        boundsVertsRef.current = extractFastBoundsVertices(geometry);

        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(filamentColor || '#00A7D9'),
          roughness: 0.38,
          metalness: 0.06,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(-rawCenter.x, -rawCenter.y, -rawCenter.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        pivot.add(mesh);
        meshRef.current = mesh;

        setLoadedMeshSeq((s) => s + 1);
        syncPivotTransform(transformRef.current);
        configureGizmoForTool(activeToolRef.current);
        requestShadowUpdateRef.current();
      } catch (err) {
        if (!cancelled) {
          setMeshError(err instanceof Error ? err.message : 'Failed to load 3D mesh');
        }
      } finally {
        if (!cancelled) setLoadingMesh(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, meshVersion]);

  // Lazily build LayOnFaceOverlay ONLY when user activates the 'snap' (F) tool
  useEffect(() => {
    const mesh = meshRef.current;
    const layOverlay = layOverlayRef.current;
    if (
      workspaceMode !== 'prepare' ||
      activeTool !== 'snap' ||
      !jobId ||
      !mesh ||
      !layOverlay
    ) {
      setBuildingLayOverlay(false);
      return;
    }

    const meshKey = `${jobId}:${meshVersion}:${loadedMeshSeq}`;
    if (layBuiltKeyRef.current === meshKey) {
      return;
    }

    let cancelled = false;
    const posAttr = mesh.geometry.getAttribute('position');
    const isHeavy = Boolean(posAttr && posAttr.count > 40000);
    if (isHeavy) {
      setBuildingLayOverlay(true);
    }

    const runBuild = () => {
      if (cancelled || !meshRef.current || !layOverlayRef.current) return;
      layOverlayRef.current.buildFromGeometry(
        meshRef.current.geometry,
        meshCenterOffsetRef.current,
        transformRef.current.scale
      );
      lastBuiltScaleRef.current = transformRef.current.scale;
      layBuiltKeyRef.current = meshKey;
      setFacetCount(layOverlayRef.current.facetCount);
      setBuildingLayOverlay(false);
      configureGizmoForTool('snap');
      requestRenderRef.current();
    };

    if (isHeavy) {
      const timerId = window.setTimeout(runBuild, 16);
      return () => {
        cancelled = true;
        window.clearTimeout(timerId);
        setBuildingLayOverlay(false);
      };
    }

    runBuild();
    return () => {
      cancelled = true;
    };
  }, [activeTool, workspaceMode, jobId, meshVersion, loadedMeshSeq, configureGizmoForTool]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(filamentColor || '#00A7D9');
    requestRenderRef.current();
  }, [filamentColor]);

  useEffect(() => {
    if (
      meshRef.current &&
      layOverlayRef.current &&
      layBuiltKeyRef.current !== null &&
      Math.abs(transform.scale - lastBuiltScaleRef.current) > 1e-4
    ) {
      layOverlayRef.current.rebuildForScale(transform.scale);
      lastBuiltScaleRef.current = transform.scale;
      setFacetCount(layOverlayRef.current.facetCount);
      requestRenderRef.current();
    }
  }, [transform.scale]);

  useEffect(() => {
    syncPivotTransform(transform);
  }, [transform, syncPivotTransform]);

  useEffect(() => {
    configureGizmoForTool(activeTool);
  }, [activeTool, configureGizmoForTool]);

  // Trigger a WebGL canvas resize when the workspace tab becomes visible again
  useEffect(() => {
    if (!isVisible) return;
    const rafId = requestAnimationFrame(() => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      const renderer = rendererRef.current;
      if (!container || !camera || !renderer) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        requestRenderRef.current();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [isVisible]);

  // Sync workspace mode visibility & interaction state
  useEffect(() => {
    const isPrepare = workspaceMode === 'prepare';
    if (pivotGroupRef.current) {
      pivotGroupRef.current.visible = isPrepare;
    }
    if (gcodePreviewRef.current) {
      gcodePreviewRef.current.group.visible = !isPrepare;
    }
    if (!isPrepare) {
      setDragOverCanvas(false);
    } else {
      setIsPlaying(false);
    }
    configureGizmoForTool(isPrepare ? activeToolRef.current : null);
    requestRenderRef.current();
  }, [workspaceMode, configureGizmoForTool]);

  // Load & parse sliced G-code whenever jobId or sliceVersion changes (cached across tab switches)
  useEffect(() => {
    if (!jobId || !sliceVersion || sliceVersion <= 0) {
      gcodePreviewRef.current?.clear();
      setParsedGcode(null);
      setLoadingPreview(false);
      setPreviewError(null);
      setIsPlaying(false);
      setCurrentLayer(1);
      setCurrentMove(0);
      onPreviewStateChangeRef.current?.({
        loading: false,
        ready: false,
        error: null,
        layerCount: 0,
      });
      return;
    }

    let cancelled = false;
    setLoadingPreview(true);
    setPreviewError(null);
    setIsPlaying(false);
    onPreviewStateChangeRef.current?.({
      loading: true,
      ready: false,
      error: null,
      layerCount: 0,
    });

    (async () => {
      try {
        const gcodeText = await api.fetchJobGcodeText(jobId);
        if (cancelled) return;
        const parsed = parseGcode(gcodeText, {
          bedX: bedDimsRef.current.bedX,
          bedY: bedDimsRef.current.bedY,
          posX: transformRef.current.posX,
          posY: transformRef.current.posY,
        });
        if (cancelled) return;

        setParsedGcode(parsed);
        if (parsed.layerCount > 0) {
          const lastIdx = parsed.layerCount - 1;
          const lastMoveCount = parsed.layers[lastIdx].moveCount;
          setCurrentLayer(parsed.layerCount);
          setCurrentMove(lastMoveCount);
          gcodePreviewRef.current?.load(parsed, filamentColor);
          gcodePreviewRef.current?.setColorMode(colorMode, filamentColor);
          gcodePreviewRef.current?.setVisibleFeatures(hiddenFeatures, showTravels);
          gcodePreviewRef.current?.setRange(lastIdx, lastMoveCount, false);
          onPreviewStateChangeRef.current?.({
            loading: false,
            ready: true,
            error: null,
            layerCount: parsed.layerCount,
          });
        } else {
          gcodePreviewRef.current?.clear();
          setCurrentLayer(1);
          setCurrentMove(0);
          const emptyMsg = t.workspace.tabs.previewEmpty;
          setPreviewError(emptyMsg);
          onPreviewStateChangeRef.current?.({
            loading: false,
            ready: false,
            error: emptyMsg,
            layerCount: 0,
          });
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : t.workspace.tabs.previewError;
        setParsedGcode(null);
        gcodePreviewRef.current?.clear();
        setPreviewError(msg);
        onPreviewStateChangeRef.current?.({
          loading: false,
          ready: false,
          error: msg,
          layerCount: 0,
        });
      } finally {
        if (!cancelled) {
          setLoadingPreview(false);
          requestRenderRef.current();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, sliceVersion]);

  // Sync preview color mode & filament color
  useEffect(() => {
    gcodePreviewRef.current?.setColorMode(colorMode, filamentColor);
    requestRenderRef.current();
  }, [colorMode, filamentColor]);

  // Sync hidden feature toggles & travel visibility
  useEffect(() => {
    gcodePreviewRef.current?.setVisibleFeatures(hiddenFeatures, showTravels);
    requestRenderRef.current();
  }, [hiddenFeatures, showTravels]);

  // Sync active layer & move draw range
  useEffect(() => {
    if (!parsedGcode || parsedGcode.layerCount === 0) return;
    const layerIdx = Math.max(0, Math.min(parsedGcode.layerCount - 1, currentLayer - 1));
    const maxMoves = parsedGcode.layers[layerIdx].moveCount;
    const clampedMove = Math.max(0, Math.min(maxMoves, currentMove));
    gcodePreviewRef.current?.setRange(layerIdx, clampedMove, isPlaying || clampedMove < maxMoves);
    requestRenderRef.current();
  }, [parsedGcode, currentLayer, currentMove, isPlaying]);

  // Playback animation loop for bottom move scrubber
  useEffect(() => {
    if (!isPlaying || workspaceMode !== 'preview' || !parsedGcode || parsedGcode.layerCount === 0) {
      return;
    }

    let rafId = 0;
    let lastTime = performance.now();
    let carry = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      setCurrentMove((prevMove) => {
        const layerIdx = Math.max(0, Math.min(parsedGcode.layerCount - 1, currentLayer - 1));
        const maxMoves = parsedGcode.layers[layerIdx].moveCount;
        const speed = Math.max(24, maxMoves / 2.2);
        carry += dt * speed;
        const step = Math.floor(carry);
        if (step <= 0) return prevMove;
        carry -= step;
        const nextMove = prevMove + step;
        if (nextMove >= maxMoves) {
          if (currentLayer < parsedGcode.layerCount) {
            setCurrentLayer((l) => Math.min(parsedGcode.layerCount, l + 1));
            return 0;
          }
          setIsPlaying(false);
          return maxMoves;
        }
        return nextMove;
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, workspaceMode, parsedGcode, currentLayer]);

  // Global keyboard shortcuts (Prepare: M, R, S, F, Escape | Preview: ArrowUp/Down, Space)
  useEffect(() => {
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable ||
          target.closest('dialog[open]')
        ) {
          return;
        }
      }

      if (workspaceModeRef.current === 'preview') {
        if (!parsedGcode || parsedGcode.layerCount === 0) return;
        const step = ev.shiftKey ? 10 : 1;
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          setIsPlaying(false);
          setCurrentLayer((prev) => {
            const next = Math.min(parsedGcode.layerCount, prev + step);
            setCurrentMove(parsedGcode.layers[next - 1].moveCount);
            return next;
          });
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          setIsPlaying(false);
          setCurrentLayer((prev) => {
            const next = Math.max(1, prev - step);
            setCurrentMove(parsedGcode.layers[next - 1].moveCount);
            return next;
          });
        } else if (ev.key === ' ') {
          ev.preventDefault();
          setIsPlaying((prev) => {
            if (!prev) {
              const lIdx = Math.max(0, Math.min(parsedGcode.layerCount - 1, currentLayer - 1));
              if (currentMove >= parsedGcode.layers[lIdx].moveCount) {
                setCurrentMove(0);
              }
            }
            return !prev;
          });
        }
        return;
      }

      if (ev.key === 'Escape') {
        setOverlayOpen(false);
        setActiveTool(null);
        return;
      }

      if (!jobId) return;

      const key = ev.key.toLowerCase();
      if (key === 'm') {
        ev.preventDefault();
        setActiveTool('move');
        setOverlayOpen(true);
      } else if (key === 'r') {
        ev.preventDefault();
        setActiveTool('rotate');
        setOverlayOpen(true);
      } else if (key === 's') {
        ev.preventDefault();
        setActiveTool('scale');
        setOverlayOpen(true);
      } else if (key === 'f') {
        ev.preventDefault();
        setActiveTool('snap');
        setOverlayOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jobId, parsedGcode, currentLayer, currentMove]);

  const eulerDeg = useMemo(() => {
    const q = new THREE.Quaternion(
      transform.quatX,
      transform.quatY,
      transform.quatZ,
      transform.quatW
    ).normalize();
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return {
      x: Math.round(e.x * RAD2DEG),
      y: Math.round(e.y * RAD2DEG),
      z: Math.round(e.z * RAD2DEG),
    };
  }, [transform.quatX, transform.quatY, transform.quatZ, transform.quatW]);

  const setEulerAxis = (axis: 'x' | 'y' | 'z', deg: number) => {
    const clampedDeg = Math.max(-180, Math.min(180, deg));
    const next = { ...eulerDeg, [axis]: clampedDeg };
    const e = new THREE.Euler(next.x * DEG2RAD, next.y * DEG2RAD, next.z * DEG2RAD, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e).normalize();
    onTransformChange({
      ...transform,
      quatX: q.x,
      quatY: q.y,
      quatZ: q.z,
      quatW: q.w,
    });
  };

  const rotateBy90 = (axis: 'x' | 'y' | 'z', sign: 1 | -1) => {
    const cur = new THREE.Quaternion(
      transform.quatX,
      transform.quatY,
      transform.quatZ,
      transform.quatW
    ).normalize();
    const vec =
      axis === 'x'
        ? new THREE.Vector3(1, 0, 0)
        : axis === 'y'
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
    const delta = new THREE.Quaternion().setFromAxisAngle(vec, sign * (Math.PI / 2));
    const next = delta.multiply(cur).normalize();
    onTransformChange({
      ...transform,
      quatX: next.x,
      quatY: next.y,
      quatZ: next.z,
      quatW: next.w,
    });
  };

  const handleResetRotation = () => {
    onTransformChange({
      ...transform,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
    });
  };

  const handleAxisMmChange = (axis: 'x' | 'y' | 'z', targetMm: number) => {
    const currentAxisMm =
      axis === 'x' ? bounds.widthMm : axis === 'y' ? bounds.depthMm : bounds.heightMm;
    if (currentAxisMm <= 0 || targetMm <= 0) return;
    const nextScale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, transform.scale * (targetMm / currentAxisMm))
    );
    onTransformChange({
      ...transform,
      scale: Number(nextScale.toFixed(4)),
    });
  };

  const handleResetView = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(bedX * 0.92, -bedY * 1.12, Math.max(bedZ * 0.72, 165));
    controlsRef.current.target.set(0, 0, 22);
    controlsRef.current.update();
    requestRenderRef.current();
  };

  const handleCenter = () => {
    onTransformChange({ ...transform, posX: 0, posY: 0 });
  };

  const selectTool = (mode: ToolMode) => {
    if (activeTool === mode) {
      setOverlayOpen((prev) => !prev);
    } else {
      setActiveTool(mode);
      setOverlayOpen(true);
    }
  };

  const handleCanvasDragOver = (e: React.DragEvent) => {
    if (!onDropFile || workspaceMode !== 'prepare') return;
    e.preventDefault();
    setDragOverCanvas(true);
  };

  const handleCanvasDrop = (e: React.DragEvent) => {
    if (!onDropFile || workspaceMode !== 'prepare') return;
    e.preventDefault();
    setDragOverCanvas(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onDropFile(file);
  };

  const handleSelectLayer = (nextLayer: number) => {
    if (!parsedGcode || parsedGcode.layerCount === 0) return;
    const clamped = Math.max(1, Math.min(parsedGcode.layerCount, nextLayer));
    setIsPlaying(false);
    setCurrentLayer(clamped);
    setCurrentMove(parsedGcode.layers[clamped - 1].moveCount);
  };

  const toggleFeatureVisibility = (feature: GcodeFeatureType) => {
    setHiddenFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(feature)) {
        next.delete(feature);
      } else {
        next.add(feature);
      }
      return next;
    });
  };

  const handleTogglePlay = () => {
    if (!parsedGcode || parsedGcode.layerCount === 0) return;
    setIsPlaying((prev) => {
      if (!prev) {
        const lIdx = Math.max(0, Math.min(parsedGcode.layerCount - 1, currentLayer - 1));
        if (currentMove >= parsedGcode.layers[lIdx].moveCount) {
          setCurrentMove(0);
        }
      }
      return !prev;
    });
  };

  const supportsFocusGroup =
    typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;

  const handleTabListKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (supportsFocusGroup) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft' || ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      const targetTab =
        ev.key === 'Home'
          ? 'prepare'
          : ev.key === 'End'
            ? 'preview'
            : document.activeElement === prepareTabRef.current
              ? 'preview'
              : 'prepare';
      if (targetTab === 'prepare') {
        prepareTabRef.current?.focus();
        onWorkspaceModeChange?.('prepare');
      } else {
        previewTabRef.current?.focus();
        if (canPreview) onWorkspaceModeChange?.('preview');
      }
    }
  };

  const activeLayerMeta =
    parsedGcode && parsedGcode.layerCount > 0
      ? parsedGcode.layers[Math.max(0, Math.min(parsedGcode.layerCount - 1, currentLayer - 1))]
      : null;
  const activeLayerMoveCount = activeLayerMeta?.moveCount ?? 0;

  return (
    <div
      data-min-z={minZMm.toFixed(3)}
      data-facet-count={facetCount}
      data-workspace-mode={workspaceMode}
      onDragOver={handleCanvasDragOver}
      onDragLeave={() => setDragOverCanvas(false)}
      onDrop={handleCanvasDrop}
      className={`flex h-full w-full min-h-[280px] flex-col overflow-hidden bg-[#ECEEF2] dark:bg-[#111317] md:min-h-[420px] ${
        workspaceMode === 'prepare' && bounds.outOfBounds
          ? 'ring-2 ring-inset ring-rose-500/70'
          : ''
      }`}
    >
      {/* Top Prepare | Preview Mode Bar */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-black/[0.08] bg-white/95 px-3 dark:border-white/[0.08] dark:bg-[#15171C]/95">
        <div
          role="tablist"
          aria-label={t.workspace.tabs.tablistLabel}
          {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
          onKeyDown={handleTabListKeyDown}
          className="flex h-full items-stretch gap-1"
        >
          <button
            ref={prepareTabRef}
            type="button"
            role="tab"
            id={prepareTabId}
            aria-selected={workspaceMode === 'prepare'}
            tabIndex={supportsFocusGroup ? undefined : workspaceMode === 'prepare' ? 0 : -1}
            {...(workspaceMode === 'prepare' ? ({ focusgroupstart: '' } as Record<string, string>) : {})}
            onClick={() => onWorkspaceModeChange?.('prepare')}
            className="pw-workspace-tab"
          >
            <Move className="h-3.5 w-3.5 shrink-0" />
            <span>{t.workspace.tabs.prepare}</span>
          </button>

          <button
            ref={previewTabRef}
            type="button"
            role="tab"
            id={previewTabId}
            aria-selected={workspaceMode === 'preview'}
            aria-disabled={!canPreview}
            title={!canPreview ? t.workspace.tabs.previewDisabledHint : undefined}
            tabIndex={supportsFocusGroup ? undefined : workspaceMode === 'preview' ? 0 : -1}
            {...(workspaceMode === 'preview' ? ({ focusgroupstart: '' } as Record<string, string>) : {})}
            onClick={() => {
              if (canPreview) {
                onWorkspaceModeChange?.('preview');
              }
            }}
            className="pw-workspace-tab"
          >
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span>{t.workspace.tabs.preview}</span>
            {canPreview && sliceStale && (
              <span
                title={t.workspace.tabs.previewStaleBadge}
                className="inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-700 dark:text-amber-300"
              >
                {t.workspace.tabs.previewStaleBadge}
              </span>
            )}
          </button>
        </div>

        {/* Right Readout & Reset Camera */}
        <div className="flex items-center gap-2">
          {workspaceMode === 'prepare' && jobId && bounds.widthMm > 0 && (
            <div className="hidden rounded-lg border border-black/[0.08] bg-[#F6F7F9] px-2.5 py-1 font-mono text-xs tabular-nums text-[#111318] dark:border-white/[0.09] dark:bg-[#0D0E11] dark:text-[#F4F5F7] md:block">
              {bounds.widthMm.toFixed(1)} × {bounds.depthMm.toFixed(1)} × {bounds.heightMm.toFixed(1)} mm
            </div>
          )}
          {workspaceMode === 'preview' && parsedGcode && parsedGcode.layerCount > 0 && activeLayerMeta && (
            <div className="hidden rounded-lg border border-black/[0.08] bg-[#F6F7F9] px-2.5 py-1 font-mono text-xs tabular-nums text-[#111318] dark:border-white/[0.09] dark:bg-[#0D0E11] dark:text-[#F4F5F7] sm:block">
              {t.workspace.preview.layerOf
                .replace('{current}', String(currentLayer))
                .replace('{total}', String(parsedGcode.layerCount))}{' '}
              · {t.workspace.preview.zHeight.replace('{z}', activeLayerMeta.z.toFixed(2))}
            </div>
          )}
          <button
            type="button"
            onClick={handleResetView}
            title={t.workspace.toolbar.resetView}
            className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] bg-[#F6F7F9] px-2.5 py-1 text-xs font-medium text-[#111318] transition-colors hover:bg-[#EFEFF3] dark:border-white/[0.09] dark:bg-[#0D0E11] dark:text-[#F4F5F7] dark:hover:bg-[#1D2027]"
          >
            <Eye className="h-3.5 w-3.5 text-[#5B616E] dark:text-[#9399A6]" />
            <span className="hidden sm:inline">{t.workspace.toolbar.resetView}</span>
          </button>
        </div>
      </div>

      {/* 3D Viewport Container */}
      <div className="relative flex-1 min-h-0">
        {/* Full-Bleed Three.js Canvas */}
        <div ref={containerRef} className="h-full w-full touch-none select-none" />

        {/* Prepare Mode Overlays */}
        {workspaceMode === 'prepare' && (
          <>
            {/* Drag-over Canvas Overlay */}
            {dragOverCanvas && (
              <div className="pointer-events-none absolute inset-4 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-[#00A7D9] bg-[#00A7D9]/10">
                <div className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[#111318] shadow-lg dark:bg-[#15171C] dark:text-[#F4F5F7]">
                  {t.workspace.dropzoneTitle}
                </div>
              </div>
            )}

            {/* Calm Empty Viewport State */}
            {!jobId && !loadingMesh && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                <div className="max-w-xs rounded-2xl border border-black/[0.08] bg-white/95 p-6 text-center shadow-sm dark:border-white/[0.09] dark:bg-[#15171C]/95">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[#EFEFF3] text-[#5B616E] dark:bg-[#1D2027] dark:text-[#9399A6]">
                    <Upload className="h-5 w-5" />
                  </div>
                  <h2 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                    {t.workspace.emptyViewportTitle}
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
                    {t.workspace.emptyViewportDesc}
                  </p>
                </div>
              </div>
            )}

            {/* Loading Indicator */}
            {loadingMesh && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/25">
                <div className="rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-sm font-medium text-[#111318] shadow-lg dark:border-white/[0.1] dark:bg-[#15171C] dark:text-[#F4F5F7]">
                  {t.workspace.uploadingMesh}
                </div>
              </div>
            )}

            {meshError && (
              <div className="absolute bottom-4 left-4 right-4 z-20 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-medium text-white shadow-sm">
                {meshError}
              </div>
            )}

            {/* Out of bounds alert */}
            {bounds.outOfBounds && (
              <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 flex justify-center">
                <div className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-md">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{t.workspace.outOfBoundsBanner}</span>
                </div>
              </div>
            )}

            {/* Top-Center OrcaSlicer Floating Toolbar + Anchored Contextual Popover */}
            {jobId && !isMobileViewport && (
              <div className="pointer-events-none absolute left-1/2 top-4 z-10 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col items-center gap-2">
          {/* Primary Toolbar */}
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-0.5 whitespace-nowrap rounded-full border border-black/[0.08] bg-white/90 p-1 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-[#15171C]/90">
            <button
              type="button"
              onClick={() => selectTool('move')}
              title={`${t.workspace.toolbar.move} (M)`}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
                activeTool === 'move'
                  ? 'bg-[#00A7D9] text-white'
                  : 'text-[#5B616E] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]'
              }`}
            >
              <Move className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t.workspace.toolbar.move}</span>
              <span
                className={`hidden font-mono text-[10px] md:inline ${
                  activeTool === 'move' ? 'text-white/80' : 'opacity-55'
                }`}
              >
                M
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectTool('rotate')}
              title={`${t.workspace.toolbar.rotate} (R)`}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
                activeTool === 'rotate'
                  ? 'bg-[#00A7D9] text-white'
                  : 'text-[#5B616E] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]'
              }`}
            >
              <RotateCw className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t.workspace.toolbar.rotate}</span>
              <span
                className={`hidden font-mono text-[10px] md:inline ${
                  activeTool === 'rotate' ? 'text-white/80' : 'opacity-55'
                }`}
              >
                R
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectTool('scale')}
              title={`${t.workspace.toolbar.scale} (S)`}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
                activeTool === 'scale'
                  ? 'bg-[#00A7D9] text-white'
                  : 'text-[#5B616E] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]'
              }`}
            >
              <Maximize2 className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t.workspace.toolbar.scale}</span>
              <span
                className={`hidden font-mono text-[10px] md:inline ${
                  activeTool === 'scale' ? 'text-white/80' : 'opacity-55'
                }`}
              >
                S
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectTool('snap')}
              title={`${t.workspace.toolbar.snapFace} (F)`}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
                activeTool === 'snap'
                  ? 'bg-[#00A7D9] text-white'
                  : 'text-[#5B616E] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]'
              }`}
            >
              <Magnet className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{t.workspace.toolbar.snapFace}</span>
              <span
                className={`hidden font-mono text-[10px] md:inline ${
                  activeTool === 'snap' ? 'text-white/80' : 'opacity-55'
                }`}
              >
                F
              </span>
            </button>

            <div className="mx-1 hidden h-4 w-px bg-black/[0.1] dark:bg-white/[0.12] sm:block" />

            <button
              type="button"
              onClick={handleCenter}
              title={t.workspace.toolbar.center}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium text-[#5B616E] transition-colors hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]"
            >
              <Crosshair className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden lg:inline">{t.workspace.toolbar.center}</span>
            </button>

            {onReorient && (
              <button
                type="button"
                onClick={onReorient}
                disabled={reorienting}
                title={t.workspace.toolbar.reorient}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium text-[#5B616E] transition-colors hover:bg-black/[0.05] hover:text-[#111318] disabled:opacity-45 dark:text-[#9399A6] dark:hover:bg-white/[0.07] dark:hover:text-[#F4F5F7]"
              >
                <Compass className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden lg:inline">{t.workspace.toolbar.reorient}</span>
              </button>
            )}
          </div>

          {/* Anchored Floating Contextual Overlay */}
          {overlayOpen && activeTool !== null && (
            <div className="pointer-events-auto w-max max-w-[92vw] rounded-2xl border border-black/[0.08] bg-white/90 px-3.5 py-2.5 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-[#15171C]/90">
              {activeTool === 'move' && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="flex items-center gap-1.5 rounded-xl bg-black/[0.04] px-2.5 py-1 dark:bg-white/[0.05]">
                    <span className="h-2 w-2 rounded-full bg-rose-500" />
                    <span className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                      {t.workspace.toolbar.posX}
                    </span>
                    <NumericInput
                      value={transform.posX}
                      step={1}
                      decimals={1}
                      ariaLabel="Move X (mm)"
                      onCommit={(nextX) => onTransformChange({ ...transform, posX: nextX })}
                      className="no-spinner w-16 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                    />
                    <span className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">mm</span>
                  </div>

                  <div className="flex items-center gap-1.5 rounded-xl bg-black/[0.04] px-2.5 py-1 dark:bg-white/[0.05]">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                      {t.workspace.toolbar.posY}
                    </span>
                    <NumericInput
                      value={transform.posY}
                      step={1}
                      decimals={1}
                      ariaLabel="Move Y (mm)"
                      onCommit={(nextY) => onTransformChange({ ...transform, posY: nextY })}
                      className="no-spinner w-16 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                    />
                    <span className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">mm</span>
                  </div>

                  <div
                    title={t.workspace.toolbar.zLockedBed}
                    className="flex items-center gap-1.5 rounded-xl bg-black/[0.03] px-2.5 py-1 opacity-80 dark:bg-white/[0.04]"
                  >
                    <span className="h-2 w-2 rounded-full bg-sky-500" />
                    <span className="text-xs font-semibold text-sky-600 dark:text-sky-400">
                      {t.workspace.toolbar.posZ}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      0.0 mm
                    </span>
                    <Lock className="h-3 w-3 text-[#5B616E] dark:text-[#9399A6]" />
                  </div>

                  <button
                    type="button"
                    onClick={handleCenter}
                    className="btn-secondary px-2.5 py-1 text-xs"
                  >
                    <Crosshair className="h-3 w-3" />
                    <span>{t.workspace.toolbar.center}</span>
                  </button>
                </div>
              )}

              {activeTool === 'rotate' && (
                <div className="w-[min(460px,84vw)] space-y-2.5">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {(['x', 'y', 'z'] as const).map((axis) => {
                      const dotClass =
                        axis === 'x'
                          ? 'bg-rose-500'
                          : axis === 'y'
                            ? 'bg-emerald-500'
                            : 'bg-sky-500';
                      const textClass =
                        axis === 'x'
                          ? 'text-rose-600 dark:text-rose-400'
                          : axis === 'y'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-sky-600 dark:text-sky-400';
                      const label =
                        axis === 'x'
                          ? t.workspace.toolbar.rotX
                          : axis === 'y'
                            ? t.workspace.toolbar.rotY
                            : t.workspace.toolbar.rotZ;

                      return (
                        <div
                          key={axis}
                          className="flex flex-col gap-1.5 rounded-xl bg-black/[0.03] p-2 dark:bg-white/[0.04]"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-semibold">
                              <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                              <span className={textClass}>{label}</span>
                            </span>
                            <div className="flex items-center gap-0.5 rounded-lg bg-white/80 px-1.5 py-0.5 dark:bg-[#0D0E11]/80">
                              <NumericInput
                                value={eulerDeg[axis]}
                                min={-180}
                                max={180}
                                step={1}
                                decimals={0}
                                ariaLabel={`Rotate ${axis.toUpperCase()} degrees`}
                                onCommit={(deg) => setEulerAxis(axis, deg)}
                                className="no-spinner w-11 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                              />
                              <span className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                                °
                              </span>
                            </div>
                          </div>

                          <input
                            type="range"
                            min={-180}
                            max={180}
                            step={1}
                            value={eulerDeg[axis]}
                            onChange={(e) => setEulerAxis(axis, Number(e.target.value))}
                            className="w-full"
                          />

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => rotateBy90(axis, -1)}
                              className="btn-secondary flex-1 py-1 font-mono text-[11px]"
                            >
                              <RotateCcw className="h-3 w-3" /> -90°
                            </button>
                            <button
                              type="button"
                              onClick={() => rotateBy90(axis, 1)}
                              className="btn-secondary flex-1 py-1 font-mono text-[11px]"
                            >
                              <RotateCw className="h-3 w-3" /> +90°
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleResetRotation}
                      className="btn-secondary px-2.5 py-1 font-mono text-[11px]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>{t.workspace.toolbar.resetRotation}</span>
                    </button>
                  </div>
                </div>
              )}

              {activeTool === 'scale' && (
                <div className="w-[min(430px,84vw)] space-y-2.5">
                  {/* Top Row: Global Scale % */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.workspace.toolbar.scale}
                    </span>
                    <input
                      type="range"
                      min={10}
                      max={400}
                      step={1}
                      value={Math.round(transform.scale * 100)}
                      onChange={(e) =>
                        onTransformChange({
                          ...transform,
                          scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(e.target.value) / 100)),
                        })
                      }
                      className="min-w-[110px] flex-1"
                    />
                    <div className="flex items-center gap-1 rounded-xl bg-black/[0.04] px-2 py-1 dark:bg-white/[0.05]">
                      <NumericInput
                        value={Math.round(transform.scale * 100)}
                        min={10}
                        max={400}
                        step={1}
                        decimals={0}
                        ariaLabel="Scale percentage"
                        onCommit={(pct) =>
                          onTransformChange({
                            ...transform,
                            scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, pct / 100)),
                          })
                        }
                        className="no-spinner w-12 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                      />
                      <span className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                        %
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onTransformChange({ ...transform, scale: 1.0 })}
                      className="btn-secondary px-2 py-1 font-mono text-[11px]"
                    >
                      100%
                    </button>
                    <span className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-[#5B616E] dark:bg-white/[0.06] dark:text-[#9399A6]">
                      <Lock className="h-2.5 w-2.5" />
                      {t.workspace.toolbar.uniformLock}
                    </span>
                  </div>

                  {/* Bottom Row: Linked Uniform X / Y / Z mm inputs */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex items-center justify-between gap-1 rounded-xl bg-black/[0.04] px-2 py-1 dark:bg-white/[0.05]">
                      <span className="flex items-center gap-1 text-xs font-semibold">
                        <span className="h-2 w-2 rounded-full bg-rose-500" />
                        <span className="text-rose-600 dark:text-rose-400">X</span>
                      </span>
                      <div className="flex items-center gap-0.5">
                        <NumericInput
                          value={bounds.widthMm}
                          min={0.5}
                          step={1}
                          decimals={1}
                          ariaLabel="Width X (mm)"
                          onCommit={(mm) => handleAxisMmChange('x', mm)}
                          className="no-spinner w-14 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                        />
                        <span className="text-[10px] text-[#5B616E] dark:text-[#9399A6]">mm</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-1 rounded-xl bg-black/[0.04] px-2 py-1 dark:bg-white/[0.05]">
                      <span className="flex items-center gap-1 text-xs font-semibold">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">Y</span>
                      </span>
                      <div className="flex items-center gap-0.5">
                        <NumericInput
                          value={bounds.depthMm}
                          min={0.5}
                          step={1}
                          decimals={1}
                          ariaLabel="Depth Y (mm)"
                          onCommit={(mm) => handleAxisMmChange('y', mm)}
                          className="no-spinner w-14 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                        />
                        <span className="text-[10px] text-[#5B616E] dark:text-[#9399A6]">mm</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-1 rounded-xl bg-black/[0.04] px-2 py-1 dark:bg-white/[0.05]">
                      <span className="flex items-center gap-1 text-xs font-semibold">
                        <span className="h-2 w-2 rounded-full bg-sky-500" />
                        <span className="text-sky-600 dark:text-sky-400">Z</span>
                      </span>
                      <div className="flex items-center gap-0.5">
                        <NumericInput
                          value={bounds.heightMm}
                          min={0.5}
                          step={1}
                          decimals={1}
                          ariaLabel="Height Z (mm)"
                          onCommit={(mm) => handleAxisMmChange('z', mm)}
                          className="no-spinner w-14 bg-transparent text-right font-mono text-xs tabular-nums text-[#111318] focus:outline-none dark:text-[#F4F5F7]"
                        />
                        <span className="text-[10px] text-[#5B616E] dark:text-[#9399A6]">mm</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTool === 'snap' && (
                <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                  <div className="flex items-center gap-2">
                    {buildingLayOverlay ? (
                      <>
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#00A7D9]" />
                        <span>{t.workspace.toolbar.snapBuilding}</span>
                      </>
                    ) : (
                      <>
                        <Magnet className="h-4 w-4 shrink-0 text-[#00A7D9]" />
                        <span>
                          {t.workspace.toolbar.snapFaceActive.replace('{count}', String(facetCount))}
                        </span>
                      </>
                    )}
                  </div>
                  {onReorient && (
                    <button
                      type="button"
                      onClick={onReorient}
                      disabled={reorienting}
                      className="btn-secondary px-2.5 py-1 text-xs"
                    >
                      <Compass className="h-3.5 w-3.5" />
                      <span>{t.workspace.toolbar.reorient}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
          </>
        )}

        {/* Preview Mode HUD Overlays */}
        {workspaceMode === 'preview' && (
          <>
            {/* Stale Preview Banner */}
            {sliceStale && (
              <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 justify-center">
                <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber-500/40 bg-amber-50/95 px-3.5 py-1.5 text-xs font-medium text-amber-900 shadow-md backdrop-blur-md dark:border-amber-400/30 dark:bg-amber-950/90 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span>{t.workspace.tabs.previewStaleBanner}</span>
                  {onReSlice && (
                    <button
                      type="button"
                      disabled={slicing}
                      onClick={onReSlice}
                      className="rounded-full bg-amber-500 px-2.5 py-0.5 text-[11px] font-semibold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-45"
                    >
                      {slicing ? t.workspace.slicingBtn : t.workspace.tabs.reSliceBtn}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Loading Overlay */}
            {loadingPreview && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/25">
                <div className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-sm font-medium text-[#111318] shadow-lg dark:border-white/[0.1] dark:bg-[#15171C] dark:text-[#F4F5F7]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
                  <span>{t.workspace.tabs.previewLoading}</span>
                </div>
              </div>
            )}

            {/* Error Overlay */}
            {previewError && !loadingPreview && (
              <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
                <div className="max-w-sm rounded-2xl border border-rose-500/30 bg-white/95 p-4 text-center text-xs text-rose-700 shadow-lg dark:bg-[#15171C]/95 dark:text-rose-300">
                  {previewError}
                </div>
              </div>
            )}

            {/* Top-Left OrcaSlicer Legend & Color Scheme Card */}
            {parsedGcode && parsedGcode.layerCount > 0 && !loadingPreview && (
              <div className="pointer-events-auto absolute left-4 top-4 z-10 w-64 rounded-2xl border border-black/[0.08] bg-white/92 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-[#15171C]/92">
                <button
                  type="button"
                  onClick={() => setLegendOpen((o) => !o)}
                  aria-expanded={legendOpen}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]"
                >
                  <span className="flex items-center gap-1.5">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-[#00A7D9]" />
                    <span>{t.workspace.preview.legendTitle}</span>
                  </span>
                  {legendOpen ? (
                    <ChevronUp className="h-3.5 w-3.5 text-[#5B616E] dark:text-[#9399A6]" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-[#5B616E] dark:text-[#9399A6]" />
                  )}
                </button>

                {legendOpen && (
                  <div className="space-y-2.5 border-t border-black/[0.07] px-3 py-2.5 dark:border-white/[0.08]">
                    {/* Color Scheme Segmented Toggle */}
                    <div className="space-y-1">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-[#5B616E] dark:text-[#9399A6]">
                        {t.workspace.preview.colorScheme}
                      </div>
                      <div
                        role="group"
                        aria-label={t.workspace.preview.colorScheme}
                        className="grid grid-cols-3 rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.07]"
                      >
                        {(
                          [
                            ['line-type', t.workspace.preview.colorLineType],
                            ['filament', t.workspace.preview.colorFilament],
                            ['speed', t.workspace.preview.colorSpeed],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            aria-pressed={colorMode === mode}
                            onClick={() => setColorMode(mode)}
                            className={`whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
                              colorMode === mode
                                ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                                : 'text-[#5B616E] dark:text-[#9399A6]'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Thermal Speed Gradient Legend */}
                    {colorMode === 'speed' && parsedGcode.speedRange && (
                      <div className="space-y-1 rounded-lg bg-black/[0.03] px-2 py-1.5 dark:bg-white/[0.04]">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-[#5B616E] dark:text-[#9399A6]">
                          <span className="font-medium uppercase tracking-wider">
                            {t.workspace.preview.speedLegend}
                          </span>
                          <span className="font-mono font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                            {parsedGcode.speedRange.minMmS.toFixed(0)}–{parsedGcode.speedRange.maxMmS.toFixed(0)}{' '}
                            {t.workspace.preview.speedUnit}
                          </span>
                        </div>
                        <div
                          aria-label={`${parsedGcode.speedRange.minMmS.toFixed(0)}–${parsedGcode.speedRange.maxMmS.toFixed(0)} ${t.workspace.preview.speedUnit}`}
                          className="h-2.5 w-full rounded-full ring-1 ring-black/10 dark:ring-white/15"
                          style={{
                            background:
                              'linear-gradient(to right, #2563EB, #06B6D4, #22C55E, #EAB308, #EF4444)',
                          }}
                        />
                      </div>
                    )}

                    {/* Feature Type Toggles */}
                    <div className="space-y-1">
                      {GCODE_FEATURE_ORDER.filter((f) => parsedGcode.presentFeatures.includes(f)).map(
                        (feat) => {
                          const visible = !hiddenFeatures.has(feat);
                          const stat = parsedGcode.featureStats?.[feat];
                          const swatchColor =
                            colorMode === 'filament' ? filamentColor : FEATURE_COLORS[feat];
                          return (
                            <button
                              key={feat}
                              type="button"
                              aria-pressed={visible}
                              onClick={() => toggleFeatureVisibility(feat)}
                              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs transition-colors ${
                                visible
                                  ? 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.05]'
                                  : 'text-[#5B616E]/55 line-through hover:bg-black/[0.03] dark:text-[#9399A6]/55'
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15"
                                  style={{
                                    backgroundColor: swatchColor,
                                    opacity: visible ? 1 : 0.3,
                                  }}
                                />
                                <span className="truncate">{t.workspace.preview.features[feat]}</span>
                              </span>
                              {stat && (
                                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                                  {stat.sharePct.toFixed(1)}%
                                </span>
                              )}
                            </button>
                          );
                        }
                      )}

                      {parsedGcode.totalTravelSegments > 0 && (
                        <button
                          type="button"
                          aria-pressed={showTravels}
                          onClick={() => setShowTravels((v) => !v)}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs transition-colors ${
                            showTravels
                              ? 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.05]'
                              : 'text-[#5B616E]/65 hover:bg-black/[0.03] dark:text-[#9399A6]/65'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15"
                              style={{
                                backgroundColor: TRAVEL_COLOR,
                                opacity: showTravels ? 1 : 0.35,
                              }}
                            />
                            <span>{t.workspace.preview.travel}</span>
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Right-Edge Vertical Layer Slider */}
            {parsedGcode && parsedGcode.layerCount > 0 && !loadingPreview && (
              <div className="pointer-events-auto absolute bottom-20 right-4 top-16 z-10 flex flex-col items-center gap-1.5 rounded-2xl border border-black/[0.08] bg-white/92 px-2 py-2.5 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-[#15171C]/92">
                <button
                  type="button"
                  aria-label={t.workspace.preview.nextLayer}
                  title={t.workspace.preview.nextLayer}
                  disabled={currentLayer >= parsedGcode.layerCount}
                  onClick={() => handleSelectLayer(currentLayer + 1)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[#111318] transition-colors hover:bg-black/[0.06] disabled:opacity-35 dark:text-[#F4F5F7] dark:hover:bg-white/[0.08]"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>

                <div className="flex min-h-[120px] w-7 flex-1 items-stretch justify-center py-1">
                  <input
                    type="range"
                    aria-label={t.workspace.preview.layerSliderLabel}
                    aria-valuetext={`${t.workspace.preview.layerOf
                      .replace('{current}', String(currentLayer))
                      .replace('{total}', String(parsedGcode.layerCount))}, ${t.workspace.preview.zHeight.replace(
                      '{z}',
                      (activeLayerMeta?.z ?? 0).toFixed(2)
                    )}`}
                    min={1}
                    max={parsedGcode.layerCount}
                    step={1}
                    value={currentLayer}
                    onChange={(e) => handleSelectLayer(Number(e.target.value))}
                    style={
                      {
                        '--attr-min': 1,
                        '--attr-max': Math.max(1, parsedGcode.layerCount),
                        '--control-value': currentLayer,
                      } as React.CSSProperties
                    }
                    className="pw-preview-slider pw-preview-slider-vertical"
                  />
                </div>

                <button
                  type="button"
                  aria-label={t.workspace.preview.prevLayer}
                  title={t.workspace.preview.prevLayer}
                  disabled={currentLayer <= 1}
                  onClick={() => handleSelectLayer(currentLayer - 1)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[#111318] transition-colors hover:bg-black/[0.06] disabled:opacity-35 dark:text-[#F4F5F7] dark:hover:bg-white/[0.08]"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>

                <div className="shrink-0 border-t border-black/[0.07] pt-1.5 text-center font-mono text-[10px] leading-tight tabular-nums text-[#111318] dark:border-white/[0.08] dark:text-[#F4F5F7]">
                  <div className="font-semibold">
                    {currentLayer}/{parsedGcode.layerCount}
                  </div>
                  <div className="text-[#5B616E] dark:text-[#9399A6]">
                    {(activeLayerMeta?.z ?? 0).toFixed(1)}mm
                  </div>
                </div>
              </div>
            )}

            {/* Bottom-Center Horizontal Move Scrubber + Play/Pause */}
            {parsedGcode && parsedGcode.layerCount > 0 && !loadingPreview && (
              <div className="pointer-events-auto absolute bottom-4 left-1/2 z-10 flex w-[min(460px,calc(100%-5.5rem))] -translate-x-1/2 items-center gap-2.5 rounded-full border border-black/[0.08] bg-white/92 px-3 py-1.5 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-[#15171C]/92">
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  aria-label={isPlaying ? t.workspace.preview.pause : t.workspace.preview.play}
                  title={isPlaying ? t.workspace.preview.pause : t.workspace.preview.play}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#00A7D9] text-white transition-colors hover:bg-[#0090BD]"
                >
                  {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-[0.5px]" />}
                </button>

                <input
                  type="range"
                  aria-label={t.workspace.preview.moveSliderLabel}
                  aria-valuetext={`${currentMove} / ${activeLayerMoveCount}`}
                  min={0}
                  max={Math.max(1, activeLayerMoveCount)}
                  step={1}
                  value={currentMove}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setCurrentMove(Number(e.target.value));
                  }}
                  style={
                    {
                      '--attr-min': 0,
                      '--attr-max': Math.max(1, activeLayerMoveCount),
                      '--control-value': currentMove,
                    } as React.CSSProperties
                  }
                  className="pw-preview-slider pw-preview-slider-horizontal flex-1"
                />

                <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                  {currentMove}/{activeLayerMoveCount}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
