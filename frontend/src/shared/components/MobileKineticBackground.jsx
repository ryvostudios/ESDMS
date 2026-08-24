import { useEffect, useRef } from "react";
import styles from "./MobileKineticBackground.module.css";

// A lighter version of SidebarKineticBackground for small/mobile surfaces —
// the mobile nav drawer and the Login page's mobile brand strip (see
// MobileNav.jsx and LoginPage.jsx). Lower density, weaker deformation, and
// a small idle drift so the grid still reads as "alive" on touch devices
// where hover doesn't exist and pointermove mostly only fires mid-drag.
// Same architecture as SidebarKineticBackground/LoginKineticBackground
// (interactionRef, canAnimate/startAnimation/stopAnimation, edge pinning,
// bounds-clamped pointer) — kept as its own component since it's shared by
// two structurally different containers (a tall narrow drawer, a wide short
// strip) rather than either desktop component.
const CELL_SIZE = 68;
const INFLUENCE_RADIUS = 150;
const MAX_WARP = 9;
const LERP = 0.08;
const IDLE_STRENGTH = 1.4;
const STEEL_RGB = "120, 132, 145";
const ACCENT_RGB = "0, 191, 239";

function buildGrid(width, height) {
  const cols = Math.max(2, Math.round(width / CELL_SIZE));
  const rows = Math.max(2, Math.round(height / CELL_SIZE));
  const points = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const baseX = (col / cols) * width;
      const baseY = (row / rows) * height;
      const pinned = row === 0 || row === rows || col === 0 || col === cols;
      points.push({ row, col, baseX, baseY, x: baseX, y: baseY, pinned, phase: Math.random() * Math.PI * 2 });
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
      if (col < cols) drawLine(ctx, point, at(row, col + 1));
      if (row < rows) drawLine(ctx, point, at(row + 1, col));
    }
  }

  for (const point of points) {
    const warp = Math.hypot(point.x - point.baseX, point.y - point.baseY);
    const active = warp > 1.5;
    const rgb = active ? ACCENT_RGB : STEEL_RGB;
    const alpha = active ? 0.45 : 0.14;
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 1.6 : 1.1, 0, Math.PI * 2);
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
  const alpha = active ? 0.26 : 0.09;
  ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

// `interactionRef` (optional) is the real hit-testable owner element to
// listen for pointer events on — this component's own container is
// pointer-events:none (it must never intercept taps/scroll) and so never
// receives pointer events itself. Falls back to the decorative container
// when omitted so the component still renders without throwing.
export function MobileKineticBackground({ interactionRef } = {}) {
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

    // The drawer unmounts entirely when closed (see MobileNav.jsx), so
    // there's no "hidden but mounted" case there — but the Login mobile
    // strip stays mounted and goes `display: none` above the mobile
    // breakpoint (see LoginPage.module.css), the same shape as the
    // desktop sidebar's collapse. canAnimate() covers both: a 0×0
    // container (or a hidden document) never gets a frame scheduled.
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

    function step(time) {
      for (const point of grid.points) {
        let targetX = point.baseX;
        let targetY = point.baseY;

        if (!point.pinned) {
          // Very subtle idle drift so the grid still reads as "alive" on
          // touch devices, where hover doesn't exist and pointermove
          // mostly only fires mid-drag rather than continuously.
          targetX += Math.sin(time * 0.0007 + point.phase) * IDLE_STRENGTH;
          targetY += Math.cos(time * 0.0006 + point.phase) * IDLE_STRENGTH;
        }

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

    // Plain pointermove/pointerleave — no preventDefault, no touch-action
    // changes, nothing that could interfere with scrolling or taps. This
    // is purely a passive listener for visual feedback.
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
