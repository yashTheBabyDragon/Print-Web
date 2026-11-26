import * as THREE from 'three';

const IDLE_COLOR = 0x00a7d9;
const ACTIVE_COLOR = 0x38c6f4;
const EDGE_OUTLINE_COLOR = 0x0b1118;

const MIN_SCALE = 0.1;
const MAX_SCALE = 4.0;

const UP_Y = new THREE.Vector3(0, 1, 0);
const OUTWARD_DIR = new THREE.Vector3(1, -1, 1).normalize();

/**
 * OrcaSlicer-style single-arm locked uniform scale gizmo in world space.
 *
 * Displays the live world-space bounding box wireframe and a single corner arm
 * protruding from the top-front-right corner `(max.x, min.y, max.z)` along
 * `normalize(1, -1, 1)` with a tactile grab cube and generous hit collider.
 */
export class UniformScaleGizmo {
  readonly group: THREE.Group;

  private readonly contentGroup: THREE.Group;
  private readonly wireframeMesh: THREE.LineSegments;
  private readonly stemMesh: THREE.Mesh;
  private readonly cubeMesh: THREE.Mesh;
  private readonly cubeEdgesMesh: THREE.LineSegments;
  private readonly hitHandleMesh: THREE.Mesh;
  private readonly hitArmMesh: THREE.Mesh;

  private readonly wireframeGeo: THREE.EdgesGeometry;
  private readonly stemGeo: THREE.CylinderGeometry;
  private readonly cubeGeo: THREE.BoxGeometry;
  private readonly cubeEdgesGeo: THREE.EdgesGeometry;
  private readonly hitSphereGeo: THREE.SphereGeometry;
  private readonly hitArmGeo: THREE.CylinderGeometry;

  private readonly wireframeMat: THREE.LineBasicMaterial;
  private readonly handleMat: THREE.MeshBasicMaterial;
  private readonly cubeEdgesMat: THREE.LineBasicMaterial;
  private readonly hitMat: THREE.MeshBasicMaterial;

  private _isDragging = false;
  private _isHovered = false;
  private _touchMode = false;

  private readonly handlePos = new THREE.Vector3();
  private readonly cornerPos = new THREE.Vector3();
  private readonly boxCenter = new THREE.Vector3();
  private readonly boxSize = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly armQuaternion = new THREE.Quaternion().setFromUnitVectors(UP_Y, OUTWARD_DIR);

  // Drag state
  private readonly dragPlane = new THREE.Plane();
  private readonly dragAnchor = new THREE.Vector3();
  private readonly startHandlePos = new THREE.Vector3();
  private readonly startDragPoint = new THREE.Vector3();
  private readonly dragDirection = new THREE.Vector3();
  private startScale = 1;
  private startCornerDist = 1;
  private dragScaleDenominator = 1;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'UniformScaleGizmo';

    this.contentGroup = new THREE.Group();
    this.contentGroup.visible = false;
    this.group.add(this.contentGroup);

    const unitBoxForWire = new THREE.BoxGeometry(1, 1, 1);
    this.wireframeGeo = new THREE.EdgesGeometry(unitBoxForWire);
    unitBoxForWire.dispose();

    this.wireframeMat = new THREE.LineBasicMaterial({
      color: IDLE_COLOR,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      toneMapped: false,
    });
    this.wireframeMesh = new THREE.LineSegments(this.wireframeGeo, this.wireframeMat);
    this.wireframeMesh.renderOrder = 2;
    this.contentGroup.add(this.wireframeMesh);

    this.handleMat = new THREE.MeshBasicMaterial({
      color: IDLE_COLOR,
      toneMapped: false,
    });

    this.stemGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
    this.stemMesh = new THREE.Mesh(this.stemGeo, this.handleMat);
    this.stemMesh.quaternion.copy(this.armQuaternion);
    this.stemMesh.renderOrder = 3;
    this.contentGroup.add(this.stemMesh);

    this.cubeGeo = new THREE.BoxGeometry(1, 1, 1);
    this.cubeMesh = new THREE.Mesh(this.cubeGeo, this.handleMat);
    this.cubeMesh.renderOrder = 4;

    this.cubeEdgesGeo = new THREE.EdgesGeometry(this.cubeGeo);
    this.cubeEdgesMat = new THREE.LineBasicMaterial({
      color: EDGE_OUTLINE_COLOR,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
    });
    this.cubeEdgesMesh = new THREE.LineSegments(this.cubeEdgesGeo, this.cubeEdgesMat);
    this.cubeEdgesMesh.renderOrder = 5;
    this.cubeMesh.add(this.cubeEdgesMesh);
    this.contentGroup.add(this.cubeMesh);

    // Three.js Raycaster skips objects with visible = false; use invisible material instead.
    this.hitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });

    this.hitSphereGeo = new THREE.SphereGeometry(1, 12, 10);
    this.hitHandleMesh = new THREE.Mesh(this.hitSphereGeo, this.hitMat);
    this.contentGroup.add(this.hitHandleMesh);

    this.hitArmGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
    this.hitArmMesh = new THREE.Mesh(this.hitArmGeo, this.hitMat);
    this.hitArmMesh.quaternion.copy(this.armQuaternion);
    this.contentGroup.add(this.hitArmMesh);
  }

  get isDragging(): boolean {
    return this._isDragging;
  }

  /** Enables larger visual handle and hit colliders for coarse touch pointers. */
  setTouchMode(enabled: boolean): void {
    this._touchMode = enabled;
  }

  /**
   * Updates the Box3 wireframe and scales/positions the single corner arm and
   * grab cube based on camera distance so the gizmo stays an ergonomic size at any zoom.
   */
  updateFromBox(box: THREE.Box3, camera: THREE.PerspectiveCamera): void {
    if (box.isEmpty()) {
      this.contentGroup.visible = false;
      return;
    }

    this.contentGroup.visible = true;
    box.getCenter(this.boxCenter);
    box.getSize(this.boxSize);

    this.wireframeMesh.position.copy(this.boxCenter);
    this.wireframeMesh.scale.set(
      Math.max(this.boxSize.x, 1e-4),
      Math.max(this.boxSize.y, 1e-4),
      Math.max(this.boxSize.z, 1e-4)
    );

    this.cornerPos.set(box.max.x, box.min.y, box.max.z);

    // Two-pass distance estimate so armLength reflects camera distance to handlePos.
    const approxDist = Math.max(camera.position.distanceTo(this.cornerPos), 1e-3);
    let armLength = THREE.MathUtils.clamp(approxDist * 0.045, 1.5, 45);
    this.handlePos.copy(this.cornerPos).addScaledVector(OUTWARD_DIR, armLength);

    const dist = Math.max(camera.position.distanceTo(this.handlePos), 1e-3);
    armLength = THREE.MathUtils.clamp(dist * 0.045, 1.5, 45);
    const touchBoost = this._touchMode ? 1.25 : 1.0;
    const cubeSize = THREE.MathUtils.clamp(dist * 0.018 * touchBoost, 0.6, 22);
    const stemRadius = cubeSize * 0.15;

    this.handlePos.copy(this.cornerPos).addScaledVector(OUTWARD_DIR, armLength);
    this.midpoint.copy(this.cornerPos).addScaledVector(OUTWARD_DIR, armLength * 0.5);

    this.stemMesh.position.copy(this.midpoint);
    this.stemMesh.scale.set(stemRadius, armLength, stemRadius);

    this.cubeMesh.position.copy(this.handlePos);
    this.cubeMesh.scale.setScalar(cubeSize);

    const hitSphereRadius = cubeSize * (this._touchMode ? 2.4 : 1.65);
    this.hitHandleMesh.position.copy(this.handlePos);
    this.hitHandleMesh.scale.setScalar(hitSphereRadius);

    const hitArmRadius = cubeSize * (this._touchMode ? 1.35 : 0.8);
    this.hitArmMesh.position.copy(this.midpoint);
    this.hitArmMesh.scale.set(hitArmRadius, armLength, hitArmRadius);

    this.group.updateMatrixWorld(true);
  }

  setHovered(hovered: boolean): void {
    if (this._isHovered === hovered) return;
    this._isHovered = hovered;
    this.syncMaterials();
  }

  isHit(raycaster: THREE.Raycaster): boolean {
    if (!this.group.visible || !this.contentGroup.visible) {
      return false;
    }
    const hits = raycaster.intersectObjects(
      [this.hitHandleMesh, this.hitArmMesh, this.cubeMesh],
      false
    );
    return hits.length > 0;
  }

  beginDrag(
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera,
    box: THREE.Box3,
    currentScale: number
  ): boolean {
    if (box.isEmpty() || !this.group.visible) {
      return false;
    }

    this.updateFromBox(box, camera);
    if (!this.isHit(raycaster)) {
      return false;
    }

    camera.updateMatrixWorld(true);

    // Anchor on the build-plate center of the model's footprint.
    this.dragAnchor.set(
      (box.min.x + box.max.x) * 0.5,
      (box.min.y + box.max.y) * 0.5,
      box.min.z
    );
    this.startHandlePos.copy(this.handlePos);
    this.startScale = THREE.MathUtils.clamp(currentScale, MIN_SCALE, MAX_SCALE);
    this.startCornerDist = Math.max(this.cornerPos.distanceTo(this.dragAnchor), 1e-3);

    const planeNormal = new THREE.Vector3();
    camera.getWorldDirection(planeNormal).negate().normalize();
    this.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, this.startHandlePos);

    if (!raycaster.ray.intersectPlane(this.dragPlane, this.startDragPoint)) {
      this.startDragPoint.copy(this.startHandlePos);
    }

    // Project the outward 3D diagonal (handlePos - anchor) onto the camera-facing drag plane
    // so dragging tracks the handle visually without exploding if viewed nearly head-on.
    const diag3D = this.startHandlePos.clone().sub(this.dragAnchor).normalize();
    const projectedDiag = diag3D
      .clone()
      .addScaledVector(planeNormal, -diag3D.dot(planeNormal));
    const projLen = projectedDiag.length();

    const camDist = Math.max(camera.position.distanceTo(this.startHandlePos), 1e-3);
    if (projLen >= 0.25) {
      this.dragDirection.copy(projectedDiag).divideScalar(projLen);
      this.dragScaleDenominator = Math.max(
        this.startCornerDist * Math.max(projLen, 0.35),
        camDist * 0.04,
        1
      );
    } else {
      const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      this.dragDirection.copy(camRight).add(camUp).normalize();
      this.dragScaleDenominator = Math.max(
        this.startCornerDist * 0.35,
        camDist * 0.04,
        1
      );
    }

    this._isDragging = true;
    this.syncMaterials();
    return true;
  }

  updateDrag(raycaster: THREE.Raycaster): number | null {
    if (!this._isDragging) {
      return null;
    }

    const hitPoint = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.dragPlane, hitPoint)) {
      return null;
    }

    const delta = hitPoint.sub(this.startDragPoint).dot(this.dragDirection);
    const nextScale = this.startScale * (1 + delta / this.dragScaleDenominator);
    if (!Number.isFinite(nextScale)) {
      return null;
    }

    return THREE.MathUtils.clamp(nextScale, MIN_SCALE, MAX_SCALE);
  }

  endDrag(): void {
    this._isDragging = false;
    this._isHovered = false;
    this.syncMaterials();
  }

  dispose(): void {
    this.wireframeGeo.dispose();
    this.stemGeo.dispose();
    this.cubeGeo.dispose();
    this.cubeEdgesGeo.dispose();
    this.hitSphereGeo.dispose();
    this.hitArmGeo.dispose();

    this.wireframeMat.dispose();
    this.handleMat.dispose();
    this.cubeEdgesMat.dispose();
    this.hitMat.dispose();

    this.cubeMesh.clear();
    this.contentGroup.clear();
    this.group.clear();
  }

  private syncMaterials(): void {
    const active = this._isHovered || this._isDragging;
    this.handleMat.color.setHex(active ? ACTIVE_COLOR : IDLE_COLOR);
  }
}
