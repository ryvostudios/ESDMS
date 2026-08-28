import { Router } from "express";
import pool from "../config/database.js";
import config from "../config/env.js";
import { EXPECTED_MIGRATION, inspectSchemaCompatibility } from "../shared/db/schema-compatibility.js";

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
    const compatibility = await inspectSchemaCompatibility(pool);
    const ready = compatibility.schemaCompatible;
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: ready ? "ready" : "not_ready",
        backendRevision: config.buildRevision,
        ...compatibility,
      },
    });
  } catch {
    res.status(503).json({
      success: false,
      data: {
        status: "not_ready",
        backendRevision: config.buildRevision,
        expectedMigration: EXPECTED_MIGRATION,
        schemaCompatible: false,
      },
    });
  }
});

export default router;
