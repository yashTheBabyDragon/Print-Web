import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  AlertTriangle,
  Compass,
  Crosshair,
  Eye,
  Lock,
  Magnet,
  Maximize2,
  Move,
  RotateCcw,
  RotateCw,
  Upload,
} from 'lucide-react';
import { api } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import { LayOnFaceOverlay } from '../three/layOnFaceOverlay';
import { UniformScaleGizmo } from '../three/uniformScaleGizmo';

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
}: BuildPlate3DProps) {
  const { theme } = useTheme();
  const { t } = useI18n();

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

  const transformRef = useRef(transform);
  transformRef.current = transform;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;

  const bedDimsRef = useRef({ bedX, bedY, bedZ, theme });
  bedDimsRef.current = { bedX, bedY, bedZ, theme };

  const isDraggingGizmoRef = useRef(false);
  const lastBuiltScaleRef = useRef(1.0);

  const [activeTool, setActiveTool] = useState<ToolMode | null>('move');
  const activeToolRef = useRef<ToolMode | null>(activeTool);
  activeToolRef.current = activeTool;

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
    return computeExactWorldBox(mesh, hullVerts);
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
    },
    [evaluateBoundsFromBox, getExactMeshBox]
  );

  const configureGizmoForTool = useCallback((tool: ToolMode | null) => {
    const tc = transformControlsRef.current;
    const pivot = pivotGroupRef.current;
    const scaleGizmo = scaleGizmoRef.current;
    const layOverlay = layOverlayRef.current;
    const hasMesh = Boolean(pivot && meshRef.current);

    if (layOverlay) {
      layOverlay.group.visible = tool === 'snap' && hasMesh;
      if (tool !== 'snap') {
        layOverlay.setHoveredObject(null);
      }
    }

    if (scaleGizmo) {
      if (tool === 'scale' && meshRef.current && pivot && cameraRef.current) {
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

    if (!hasMesh || !pivot || tool === null || tool === 'snap' || tool === 'scale') {
      tc.detach();
      return;
    }

    tc.attach(pivot);
    if (tool === 'move') {
      tc.setMode('translate');
      tc.setSpace('world');
      tc.showX = true;
      tc.showY = true;
      tc.showZ = false;
    } else if (tool === 'rotate') {
      tc.setMode('rotate');
      tc.setSpace('world');
      tc.showX = true;
      tc.showY = true;
      tc.showZ = true;
    }
  }, []);

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
    scene.add(pivotGroup);
    pivotGroupRef.current = pivotGroup;

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

    const onDraggingChanged = (event: { value: unknown }) => {
      const isDragging = Boolean(event.value);
      isDraggingGizmoRef.current = isDragging;
      controls.enabled = !isDragging;
      if (!isDragging) {
        syncPivotTransform(transformRef.current);
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
      if (ev.button !== 0 || !meshRef.current) return;

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
      if (!meshRef.current) return;

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
        renderer.domElement.style.cursor = hitGizmo ? 'grab' : 'default';
        return;
      }

      if (activeToolRef.current === 'snap' && layOverlay.group.visible) {
        const hits = raycaster.intersectObjects(layOverlay.getPickables(), false);
        const firstHit = hits[0];
        if (firstHit && layOverlay.getFacetLocalNormal(firstHit.object) !== null) {
          layOverlay.setHoveredObject(firstHit.object);
          renderer.domElement.style.cursor = 'pointer';
        } else {
          layOverlay.setHoveredObject(null);
          renderer.domElement.style.cursor = 'default';
        }
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
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      if (
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
    };
    animate();

    const observer = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
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

    // Quiet front-edge indicator in GG cyan
    const frontGeo = new THREE.BoxGeometry(Math.min(48, bedX * 0.2), 1.8, 0.6);
    const frontMat = new THREE.MeshBasicMaterial({ color: 0x00a7d9 });
    const frontBar = new THREE.Mesh(frontGeo, frontMat);
    frontBar.position.set(0, -bedY / 2 - 2, 0.3);
    bedGroup.add(frontBar);

    syncPivotTransform(transformRef.current);
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
    setFacetCount(0);

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
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        const rawBox = geometry.boundingBox!;
        const rawCenter = new THREE.Vector3();
        rawBox.getCenter(rawCenter);

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

        if (layOverlayRef.current) {
          layOverlayRef.current.buildFromGeometry(
            geometry,
            new THREE.Vector3(-rawCenter.x, -rawCenter.y, -rawCenter.z),
            transformRef.current.scale
          );
          lastBuiltScaleRef.current = transformRef.current.scale;
          setFacetCount(layOverlayRef.current.facetCount);
        }

        syncPivotTransform(transformRef.current);
        configureGizmoForTool(activeToolRef.current);
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

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(filamentColor || '#00A7D9');
  }, [filamentColor]);

  useEffect(() => {
    if (
      meshRef.current &&
      layOverlayRef.current &&
      Math.abs(transform.scale - lastBuiltScaleRef.current) > 1e-4
    ) {
      layOverlayRef.current.rebuildForScale(transform.scale);
      lastBuiltScaleRef.current = transform.scale;
      setFacetCount(layOverlayRef.current.facetCount);
    }
  }, [transform.scale]);

  useEffect(() => {
    syncPivotTransform(transform);
  }, [transform, syncPivotTransform]);

  useEffect(() => {
    configureGizmoForTool(activeTool);
  }, [activeTool, configureGizmoForTool]);

  // Global keyboard shortcuts (M, R, S, F, Escape)
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
  }, [jobId]);

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
    if (!onDropFile) return;
    e.preventDefault();
    setDragOverCanvas(true);
  };

  const handleCanvasDrop = (e: React.DragEvent) => {
    if (!onDropFile) return;
    e.preventDefault();
    setDragOverCanvas(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onDropFile(file);
  };

  return (
    <div
      data-min-z={minZMm.toFixed(3)}
      data-facet-count={facetCount}
      onDragOver={handleCanvasDragOver}
      onDragLeave={() => setDragOverCanvas(false)}
      onDrop={handleCanvasDrop}
      className={`relative h-full w-full min-h-[480px] overflow-hidden bg-[#ECEEF2] dark:bg-[#111317] ${
        bounds.outOfBounds ? 'ring-2 ring-inset ring-rose-500/70' : ''
      }`}
    >
      {/* Full-Bleed Three.js Canvas */}
      <div ref={containerRef} className="h-full w-full" />

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

      {/* Out of bounds alert (anchored bottom-center so it never collides with top-center toolbar) */}
      {bounds.outOfBounds && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-md">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t.workspace.outOfBoundsBanner}</span>
          </div>
        </div>
      )}

      {/* Top-right Quiet Size Readout + Reset Camera */}
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        {jobId && bounds.widthMm > 0 && (
          <div className="hidden rounded-lg border border-black/[0.08] bg-white/90 px-2.5 py-1 font-mono text-xs tabular-nums text-[#111318] backdrop-blur-md dark:border-white/[0.09] dark:bg-[#15171C]/90 dark:text-[#F4F5F7] xl:block">
            {bounds.widthMm.toFixed(1)} × {bounds.depthMm.toFixed(1)} × {bounds.heightMm.toFixed(1)} mm
          </div>
        )}
        <button
          type="button"
          onClick={handleResetView}
          title={t.workspace.toolbar.resetView}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white/90 px-2.5 py-1 text-xs font-medium text-[#111318] backdrop-blur-md transition-colors hover:bg-white dark:border-white/[0.09] dark:bg-[#15171C]/90 dark:text-[#F4F5F7] dark:hover:bg-[#1D2027]"
        >
          <Eye className="h-3.5 w-3.5 text-[#5B616E] dark:text-[#9399A6]" />
          <span className="hidden 2xl:inline">{t.workspace.toolbar.resetView}</span>
        </button>
      </div>

      {/* Top-Center OrcaSlicer Floating Toolbar + Anchored Contextual Popover */}
      {jobId && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 flex w-max max-w-[calc(100%-10rem)] -translate-x-1/2 flex-col items-center gap-2">
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
                    <Magnet className="h-4 w-4 shrink-0 text-[#00A7D9]" />
                    <span>
                      {t.workspace.toolbar.snapFaceActive.replace('{count}', String(facetCount))}
                    </span>
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
    </div>
  );
}
