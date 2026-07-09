/**
 * A blocky little avatar so the third-person camera has something to look at.
 * Limbs swing from the same bob phase that drives the camera bob.
 */
import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial } from 'three';

const PARTS = {
  skin: 0xc9895c,
  hair: 0x2d1d0f,
  shirt: 0x1ba0a0,
  sleeve: 0xc9895c,
  pants: 0x3d3d9e,
  shoe: 0x413021,
};

function box(w, h, d, color, materials) {
  const mat = new MeshBasicMaterial({ color: new Color(color) });
  materials.push({ mat, base: new Color(color) });
  const mesh = new Mesh(new BoxGeometry(w, h, d), mat);
  return mesh;
}

export class Avatar {
  constructor(scene) {
    this.root = new Group();
    this.materials = [];
    this.visible = false;

    const M = this.materials;

    // Legs pivot at the hip, arms at the shoulder — hence the offset children.
    this.leftLeg = new Group();
    this.rightLeg = new Group();
    this.leftArm = new Group();
    this.rightArm = new Group();

    const legL = box(0.24, 0.7, 0.24, PARTS.pants, M);
    legL.position.y = -0.35;
    const shoeL = box(0.245, 0.1, 0.25, PARTS.shoe, M);
    shoeL.position.y = -0.66;
    this.leftLeg.add(legL, shoeL);

    const legR = box(0.24, 0.7, 0.24, PARTS.pants, M);
    legR.position.y = -0.35;
    const shoeR = box(0.245, 0.1, 0.25, PARTS.shoe, M);
    shoeR.position.y = -0.66;
    this.rightLeg.add(legR, shoeR);

    this.leftLeg.position.set(-0.13, 0.72, 0);
    this.rightLeg.position.set(0.13, 0.72, 0);

    const body = box(0.5, 0.68, 0.26, PARTS.shirt, M);
    body.position.y = 1.07;

    const armL = box(0.2, 0.64, 0.2, PARTS.sleeve, M);
    armL.position.y = -0.28;
    this.leftArm.add(armL);
    const armR = box(0.2, 0.64, 0.2, PARTS.sleeve, M);
    armR.position.y = -0.28;
    this.rightArm.add(armR);

    this.leftArm.position.set(-0.35, 1.37, 0);
    this.rightArm.position.set(0.35, 1.37, 0);

    this.head = new Group();
    const skull = box(0.46, 0.46, 0.46, PARTS.skin, M);
    const hair = box(0.475, 0.16, 0.475, PARTS.hair, M);
    hair.position.y = 0.17;
    const hairBack = box(0.475, 0.2, 0.06, PARTS.hair, M);
    hairBack.position.set(0, 0.07, 0.215);
    this.head.add(skull, hair, hairBack);
    this.head.position.y = 1.64;

    this.root.add(this.leftLeg, this.rightLeg, body, this.leftArm, this.rightArm, this.head);
    this.root.visible = false;
    scene.add(this.root);
  }

  setVisible(v) {
    this.visible = v;
    this.root.visible = v;
  }

  /** @param {{x:number,y:number,z:number}} position feet position */
  update(position, yaw, pitch, bobPhase, bobAmount, light) {
    if (!this.visible) return;
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.y = yaw;
    this.head.rotation.x = -pitch;

    const swing = Math.sin(bobPhase) * 0.85 * bobAmount;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.8;
    this.rightArm.rotation.x = swing * 0.8;

    const f = Math.max(0.18, light);
    for (const { mat, base } of this.materials) mat.color.copy(base).multiplyScalar(f);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.root.parent?.remove(this.root);
  }
}
