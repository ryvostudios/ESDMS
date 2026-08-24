import { useEffect, useRef } from "react";
import styles from "./LoginMeshBackground.module.css";

// Steel/grey dominates; the E-Set blue-ink accent appears on a restrained
// minority of nodes/lines only (see docs/DECISIONS.md's brand-accent
// guidance — the same "accent, not the whole surface" rule tokens.css
// documents for --eset-cyan/--eset-deep-blue applies here).
const STEEL_RGB = "100, 116, 132";
const ACCENT_RGB = "6, 115, 160";
const CONNECT_RADIUS = 140;
const ATTRACT_RADIUS = 380;
const REPEL_RADIUS = 65;
const SPRING_K = 0.02;
const DAMPING = 0.9;
const ATTRACT_STRENGTH = 1.1;
const REPEL_STRENGTH = 2.4;
const IDLE_STRENGTH = 0.006;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nodeCountFor(width) {
  if (width < 640) return Math.round(clamp(width / 16, 20, 40));
  return Math.round(clamp(width / 18, 50, 90));
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
      accent: Math.random() < 0.15,
    });
  }
  return nodes;
}

// Renders one settled frame — no RAF loop, no pointer physics — for
// prefers-reduced-motion. Nodes sit at their rest positions.
function drawStatic(ctx, nodes, width, height) {
  ctx.clearRect(0, 0, width, height);
  drawConnections(ctx, nodes);
  for (const node of nodes) {
    drawNode(ctx, node);
  }
}

function drawConnections(ctx, nodes) {
  // ponytail: O(n^2) over ~90 nodes max (~8k pair checks/frame) — fine at
  // this scale; switch to a spatial grid if node counts ever grow a lot.
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
      ctx.strokeStyle = `rgba(${rgb}, ${(fade * 0.35).toFixed(3)})`;
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
  ctx.fillStyle = `rgba(${rgb}, 0.55)`;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.accent ? 2.2 : 1.8, 0, Math.PI * 2);
  ctx.fill();
}

export function LoginMeshBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = window.innerWidth;
    let height = window.innerHeight;
    let nodes = createNodes(width, height);
    let rafId = null;
    let running = false;
    const pointer = { x: 0, y: 0, active: false };

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
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
      pointer.x = event.clientX;
      pointer.y = event.clientY;
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
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!reducedMotion) {
      window.addEventListener("mousemove", handlePointerMove);
      window.addEventListener("mouseleave", handlePointerLeave);
      window.addEventListener("blur", handlePointerLeave);
      if (!document.hidden) start();
    }

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseleave", handlePointerLeave);
      window.removeEventListener("blur", handlePointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
