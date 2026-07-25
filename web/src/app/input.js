/**
 * Unified pointer input (Work Order 4, Task 2).
 *
 * One code path for mouse, touch and pen - Pointer Events, not a mouse branch
 * and a touch branch. What the gesture means depends only on how many pointers
 * are down:
 *
 *   1 pointer, moved      -> pan
 *   2 pointers            -> pinch zoom about the midpoint, and pan with it
 *   1 pointer, barely moved, released quickly -> tap/click, which *selects*
 *   wheel                 -> zoom about the cursor (desktop)
 *
 * Nothing here knows what a node is; it reports gestures and lets the caller
 * decide. `touch-action: none` on the canvas stops the browser claiming the
 * gesture first.
 */

/** A tap may drift this far (CSS px) and still count as a tap, not a drag. */
const TAP_SLOP_PX = 12;
/** ...and may last this long. Longer presses still select; this only guards drag. */
const TAP_TIME_MS = 700;

export class PointerInput {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./camera.js').Camera} camera
   * @param {{
   *   onTap: (clientX: number, clientY: number, pointerType: string) => void,
   *   onHover: (clientX: number, clientY: number) => void,
   *   onChange: () => void,
   *   getDpr: () => number,
   * }} handlers
   */
  constructor(canvas, camera, handlers) {
    this.canvas = canvas;
    this.camera = camera;
    this.handlers = handlers;
    /** @type {Map<number, {x: number, y: number, startX: number, startY: number, time: number, moved: boolean}>} */
    this.pointers = new Map();
    this.pinch = null;
    this.attach();
  }

  /** Canvas-local device pixels from a client point. */
  toDevice(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.handlers.getDpr();
    return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
  }

  attach() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        time: performance.now(),
        moved: false,
      });
      if (this.pointers.size === 2) this.beginPinch();
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', (event) => {
      const tracked = this.pointers.get(event.pointerId);

      if (!tracked) {
        // no button down: hover affordance only (desktop). Touch never gets here.
        if (event.pointerType === 'mouse') this.handlers.onHover(event.clientX, event.clientY);
        return;
      }

      const dx = event.clientX - tracked.x;
      const dy = event.clientY - tracked.y;
      tracked.x = event.clientX;
      tracked.y = event.clientY;
      if (
        Math.hypot(event.clientX - tracked.startX, event.clientY - tracked.startY) > TAP_SLOP_PX
      ) {
        tracked.moved = true;
      }

      if (this.pointers.size >= 2) {
        this.updatePinch();
        return;
      }

      const dpr = this.handlers.getDpr();
      this.camera.panBy(dx * dpr, dy * dpr);
      this.handlers.onChange();
    });

    const release = (event) => {
      const tracked = this.pointers.get(event.pointerId);
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!this.pointers.size) canvas.classList.remove('dragging');
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!tracked) return;

      const held = performance.now() - tracked.time;
      const drift = Math.hypot(event.clientX - tracked.startX, event.clientY - tracked.startY);
      if (!tracked.moved && drift <= TAP_SLOP_PX && held <= TAP_TIME_MS && !this.pinchHappened) {
        this.handlers.onTap(event.clientX, event.clientY, event.pointerType || 'mouse');
      }
      if (!this.pointers.size) this.pinchHappened = false;
    };

    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse' && !this.pointers.size) {
        this.handlers.onHover(null, null);
      }
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = this.toDevice(event.clientX, event.clientY);
        this.camera.zoomAt(point.x, point.y, Math.exp(-event.deltaY * 0.0016));
        this.handlers.onChange();
      },
      { passive: false },
    );

    // Safari pinch on trackpads arrives as gesture events; treat them as zoom.
    canvas.addEventListener('gesturestart', (event) => event.preventDefault());
  }

  beginPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
    this.pinchHappened = true;
  }

  updatePinch() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    if (!this.pinch) {
      this.beginPinch();
      return;
    }

    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dpr = this.handlers.getDpr();

    // pan by however far the two fingers moved together...
    this.camera.panBy((midX - this.pinch.midX) * dpr, (midY - this.pinch.midY) * dpr);
    // ...then zoom by however far they moved apart, about the midpoint
    const point = this.toDevice(midX, midY);
    this.camera.zoomAt(point.x, point.y, distance / this.pinch.distance);

    this.pinch = { distance, midX, midY };
    this.handlers.onChange();
  }
}
