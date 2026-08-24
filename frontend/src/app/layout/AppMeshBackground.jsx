import { useEffect, useRef } from "react";
import styles from "./AppMeshBackground.module.css";

// Connected-particle reactive mesh for the light workspace behind the
// sidebar. Same spring/attract/repel physics family as the accepted
// LoginMeshBackground, but tuned much quieter (lower alpha, steel-first
// palette) since it sits behind opaque cards/tables rather than a full-bleed
// dark hero. LoginMeshBackground itself is left untouched.
const STEEL_RGB = "97, 106, 116";
const ACCENT_RGB = "6, 115, 160";
const CONNECT_RADIUS = 150;
const ATTRACT_RADIUS = 400;
const REPEL_RADIUS = 70;
const SPRING_K = 0.02;
const DAMPING = 0.9;
const ATTRACT_STRENGTH = 1;
const REPEL_STRENGTH = 2.2;
const IDLE_STRENGTH = 0.005;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nodeCountFor(width) {
  if (width < 640) return Math.round(clamp(width / 20, 20, 40));
  return Math.round(clamp(width / 20, 50, 90));
}

function createNodes(width, height) {
  const count = nodeCountFor(width);
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const baseX = Math.random() * width;
    const baseY = Math.random() * height;
    nodes.push({
      baseX,
      baseY,
      x: baseX,
      y: baseY,
      vx: 0,
      vy: 0,
      phase: Math.random() * Math.PI * 2,
      accent: Math.random() < 0.12,
    });
  }
  return nodes;
}

function drawStatic(ctx, nodes, width, height) {
  ctx.clearRect(0, 0, width, height);
  drawConnections(ctx, nodes);
  for (const node of nodes) drawNode(ctx, node);
}

function drawConnections(ctx, nodes) {
  // ponytail: O(n^2) over ~90 nodes max, same accepted tradeoff as
  // LoginMeshBackground — see its module comment.
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= CONNECT_RADIUS) continue;

      const fade = 1 - dist / CONNECT_RADIUS;
      const rgb = a.accent && b.accent ? ACCENT_RGB : STEEL_RGB;
      ctx.strokeStyle = `rgba(${rgb}, ${(fade * 0.16).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function drawNode(ctx, node) {
  const rgb = node.accent ? ACCENT_RGB : STEEL_RGB;
  ctx.fillStyle = `rgba(${rgb}, 0.22)`;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.accent ? 2 : 1.6, 0, Math.PI * 2);
  ctx.fill();
}

// `interactionRef` (optional) is the real hit-testable owner element to
// listen for pointer events on — this component's own container is
// pointer-events:none (it must never intercept clicks/scroll) and so never
// receives pointer events itself. Falls back to the decorative container
// when omitted so the component still renders without throwing.
export function AppMeshBackground({ interactionRef } = {}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas.parentElement;
    const owner = interactionRef?.current || container;
    const ctx = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = container.clientWidth;
    let height = container.clientHeight;
    let nodes = createNodes(width, height);
    let rafId = null;
    let running = false;
    const pointer = { x: 0, y: 0, active: false };

    function resize() {
      width = container.clientWidth;
      height = container.clientHeight;
      if (width === 0 || height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = createNodes(width, height);
      if (reducedMotion) drawStatic(ctx, nodes, width, height);
    }

    function handlePointerMove(event) {
      // Coordinates are always relative to the decorative container's own
      // rect (not the owner's) — in this layout they coincide (the
      // container fills the owner via inset:0), but the canvas is what the
      // physics/drawing actually operate in, so it's the one true frame.
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // The owner can be larger than, or offset from, the canvas in a
      // future layout — a pointer position outside the canvas's own bounds
      // isn't meaningful to the physics, so treat it the same as the
      // pointer having left entirely rather than attracting nodes toward
      // an off-canvas point.
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
      for (const node of nodes) {
        let ax = (node.baseX - node.x) * SPRING_K;
        let ay = (node.baseY - node.y) * SPRING_K;

        ax += Math.sin(time * 0.0006 + node.phase) * IDLE_STRENGTH;
        ay += Math.cos(time * 0.0005 + node.phase) * IDLE_STRENGTH;

        if (pointer.active) {
          const dx = pointer.x - node.x;
          const dy = pointer.y - node.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;

          if (dist < REPEL_RADIUS) {
            const t = 1 - dist / REPEL_RADIUS;
            const force = t * t * REPEL_STRENGTH;
            ax -= (dx / dist) * force;
            ay -= (dy / dist) * force;
          } else if (dist < ATTRACT_RADIUS) {
            const t = 1 - (dist - REPEL_RADIUS) / (ATTRACT_RADIUS - REPEL_RADIUS);
            const force = t * t * ATTRACT_STRENGTH;
            ax += (dx / dist) * force;
            ay += (dy / dist) * force;
          }
        }

        node.vx = (node.vx + ax) * DAMPING;
        node.vy = (node.vy + ay) * DAMPING;
        node.x += node.vx;
        node.y += node.vy;
      }

      ctx.clearRect(0, 0, width, height);
      drawConnections(ctx, nodes);
      for (const node of nodes) drawNode(ctx, node);

      if (running) rafId = requestAnimationFrame(step);
    }

    function start() {
      if (running || reducedMotion) return;
      running = true;
      rafId = requestAnimationFrame(step);
    }

    function stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    }

    function handleVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!reducedMotion) {
      owner.addEventListener("pointermove", handlePointerMove);
      owner.addEventListener("pointerleave", handlePointerLeave);
      if (!document.hidden) start();
    }

    return () => {
      stop();
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
