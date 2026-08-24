import { useEffect, useRef } from "react";
import styles from "./SidebarKineticBackground.module.css";

// A quiet blueprint/schematic grid for the dark sidebar — distinct from
// LoginMeshBackground's free-floating particle mesh. Points sit on a fixed
// lattice and warp toward the pointer; edge rows/columns are pinned so the
// sidebar border never looks rubbery (see PART 2 of the visual pass spec).
const CELL_SIZE = 52;
const INFLUENCE_RADIUS = 220;
const MAX_WARP = 16;
const LERP = 0.08;
const STEEL_RGB = "120, 132, 145";
const ACCENT_RGB = "0, 191, 239";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildGrid(width, height) {
  const cols = Math.max(2, Math.round(width / CELL_SIZE));
  const rows = Math.max(2, Math.round(height / CELL_SIZE));
  const points = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const baseX = (col / cols) * width;
      const baseY = (row / rows) * height;
      const pinned = row === 0 || row === rows || col === 0 || col === cols;
      points.push({
        row,
        col,
        baseX,
        baseY,
        x: baseX,
        y: baseY,
        pinned,
        // Grid fades toward the bottom so the empty space below the nav
        // reads as intentionally quiet rather than an unused void.
        fadeY: 1 - clamp(row / rows, 0, 1) * 0.7,
      });
    }
  }
  return { points, cols, rows };
}

function drawStatic(ctx, grid, width, height) {
  ctx.clearRect(0, 0, width, height);
  drawGrid(ctx, grid);
}

function drawGrid(ctx, { points, cols, rows }) {
  const at = (row, col) => points[row * (cols + 1) + col];

  ctx.lineWidth = 1;
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const point = at(row, col);
      if (col < cols) {
        const next = at(row, col + 1);
        drawLine(ctx, point, next);
      }
      if (row < rows) {
        const next = at(row + 1, col);
        drawLine(ctx, point, next);
      }
    }
  }

  for (const point of points) {
    const warp = Math.hypot(point.x - point.baseX, point.y - point.baseY);
    const active = warp > 1.5;
    const rgb = active ? ACCENT_RGB : STEEL_RGB;
    const alpha = (active ? 0.5 : 0.16) * point.fadeY;
    ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 1.8 : 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLine(ctx, a, b) {
  const warp = Math.max(
    Math.hypot(a.x - a.baseX, a.y - a.baseY),
    Math.hypot(b.x - b.baseX, b.y - b.baseY),
  );
  const active = warp > 1.5;
  const rgb = active ? ACCENT_RGB : STEEL_RGB;
  const alpha = (active ? 0.3 : 0.1) * ((a.fadeY + b.fadeY) / 2);
  ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

// `interactionRef` (optional) is the real hit-testable owner element to
// listen for pointer events on — this component's own container is
// pointer-events:none (it must never intercept clicks/scroll) and so never
// receives pointer events itself. Falls back to the decorative container
// when omitted so the component still renders without throwing.
export function SidebarKineticBackground({ interactionRef } = {}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas.parentElement;
    const owner = interactionRef?.current || container;
    const ctx = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = container.clientWidth;
    let height = container.clientHeight;
    let grid = buildGrid(width, height);
    let rafId = null;
    let running = false;
    const pointer = { x: -9999, y: -9999, active: false };

    // The desktop sidebar collapses to `display: none` at narrow widths
    // (see Sidebar.module.css) while staying mounted — the container's own
    // dimensions go to 0 rather than the component unmounting. canAnimate()
    // is the single source of truth for whether a frame should be
    // scheduled at all, so a 0×0 container (or a hidden document) can never
    // leave a stray rAF loop running underneath an invisible canvas.
    function canAnimate() {
      return !reducedMotion && !document.hidden && width > 0 && height > 0;
    }

    function stopAnimation() {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function startAnimation() {
      if (running || !canAnimate()) return;
      running = true;
      rafId = requestAnimationFrame(step);
    }

    function resize() {
      width = container.clientWidth;
      height = container.clientHeight;
      if (width === 0 || height === 0) {
        // Sidebar just collapsed (or hasn't laid out yet) — nothing usable
        // to draw into, and any loop still running would just be spinning
        // on stale dimensions underneath a hidden canvas.
        stopAnimation();
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grid = buildGrid(width, height);
      if (reducedMotion) {
        drawStatic(ctx, grid, width, height);
        return;
      }
      startAnimation();
    }

    function handlePointerMove(event) {
      // Coordinates are always relative to the decorative container's own
      // rect (not the owner's) — in this layout they coincide (the
      // container fills the owner via inset:0), but the canvas is what the
      // physics/drawing actually operate in, so it's the one true frame.
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // A pointer position outside the canvas's own bounds isn't
      // meaningful to the grid warp — treat it the same as the pointer
      // having left entirely rather than warping toward an off-canvas point.
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointer.active = false;
        return;
      }

      pointer.x = x;
      pointer.y = y;
      pointer.active = true;
    }

    function handlePointerLeave() {
      pointer.active = false;
    }

    function step() {
      for (const point of grid.points) {
        let targetX = point.baseX;
        let targetY = point.baseY;

        if (pointer.active && !point.pinned) {
          const dx = point.baseX - pointer.x;
          const dy = point.baseY - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < INFLUENCE_RADIUS) {
            const t = 1 - dist / INFLUENCE_RADIUS;
            const pull = t * t * MAX_WARP;
            const nx = dist === 0 ? 0 : dx / dist;
            const ny = dist === 0 ? 0 : dy / dist;
            targetX = point.baseX - nx * pull;
            targetY = point.baseY - ny * pull;
          }
        }

        point.x += (targetX - point.x) * LERP;
        point.y += (targetY - point.y) * LERP;
      }

      ctx.clearRect(0, 0, width, height);
      drawGrid(ctx, grid);

      if (running) rafId = requestAnimationFrame(step);
    }

    function handleVisibilityChange() {
      if (document.hidden) stopAnimation();
      else startAnimation(); // no-ops if the container is still 0×0
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!reducedMotion) {
      owner.addEventListener("pointermove", handlePointerMove);
      owner.addEventListener("pointerleave", handlePointerLeave);
    }

    return () => {
      stopAnimation();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      owner.removeEventListener("pointermove", handlePointerMove);
      owner.removeEventListener("pointerleave", handlePointerLeave);
    };
    // interactionRef is a ref object — stable identity across re-renders of
    // the same mount, so listing it here doesn't cause extra effect runs;
    // it only satisfies exhaustive-deps for the `interactionRef?.current`
    // read above.
  }, [interactionRef]);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
