import { Router } from "express";
import pool from "../config/database.js";

const router = Router();

// Liveness: the process is up and answering HTTP. No dependency checks —
// a slow/down database must not make an orchestrator kill and restart a
// perfectly healthy process.
router.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: "ok",
    },
  });
});

// Readiness: can this instance actually serve traffic right now. Never
// exposes the underlying DB error to the caller — only whether it's ready.
router.get("/ready", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ success: true, data: { status: "ready" } });
  } catch {
    res.status(503).json({ success: false, data: { status: "not_ready" } });
  }
});

export default router;