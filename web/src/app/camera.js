/**
 * Continuous pan/zoom camera (Work Order 3, decision 2).
 *
 * World space is the graph's own coordinate system - the radius/angle layout
 * generated in Work Order 2. Screen space is device pixels. The whole graph is
 * always present; zoom only changes what is legible, never what exists.
 */

export class Camera {
  constructor() {
    this.x = 0; // world coordinate at the viewport centre
    this.y = 0;
    this.scale = 6;
    this.minScale = 2.2;
    this.maxScale = 40;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
  }

  resize(width, height) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /** Frame a world-space bounding box with margin. */
  fit(bounds, margin = 1.08) {
    const width = Math.max(bounds.width, 1) * margin;
    const height = Math.max(bounds.height, 1) * margin;
    this.scale = Math.min(this.viewportWidth / width, this.viewportHeight / height);
    this.minScale = this.scale * 0.7;
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.scale + this.viewportWidth / 2,
      y: (y - this.y) * this.scale + this.viewportHeight / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.viewportWidth / 2) / this.scale + this.x,
      y: (y - this.viewportHeight / 2) / this.scale + this.y,
    };
  }

  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
  }

  /** Zoom about a screen point, so the world point under the cursor stays put. */
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  centreOn(x, y, scale) {
    this.x = x;
    this.y = y;
    if (scale) this.scale = Math.min(this.maxScale, Math.max(this.minScale, scale));
  }

  /** World-space rectangle currently visible, with a margin for node radii. */
  visibleRect(pad = 4) {
    const halfWidth = this.viewportWidth / 2 / this.scale + pad;
    const halfHeight = this.viewportHeight / 2 / this.scale + pad;
    return {
      minX: this.x - halfWidth,
      minY: this.y - halfHeight,
      maxX: this.x + halfWidth,
      maxY: this.y + halfHeight,
    };
  }

  /**
   * Level of detail (decision 3). Thresholds are in screen-pixels-per-world-unit.
   *   far   - zone shapes and owned nodes only
   *   mid   - every node as a simple shape, no labels
   *   near  - full shapes, outlines and labels
   */
  lod() {
    if (this.scale < 4.2) return 'far';
    if (this.scale < 9) return 'mid';
    return 'near';
  }
}
