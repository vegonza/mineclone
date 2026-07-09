import { BoxGeometry, EdgesGeometry, LineBasicMaterial, LineSegments } from 'three';

/** The black wireframe box drawn around the block you are looking at. */
export class BlockHighlight {
  constructor(scene) {
    const box = new BoxGeometry(1.002, 1.002, 1.002);
    this.mesh = new LineSegments(
      new EdgesGeometry(box),
      new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: true }),
    );
    box.dispose();
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  showAt(x, y, z) {
    this.mesh.visible = true;
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
