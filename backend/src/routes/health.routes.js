import { Router } from "express";
import pool from "../config/database.js";
import config from "../config/env.js";
import { EXPECTED_MIGRATION, inspectSchemaCompatibility } from "../shared/db/schema-compatibility.js";
import {
  EXPECTED_RUNTIME_PROVISIONING,
  inspectRuntimeCompatibility,
} from "../shared/db/runtime-compatibility.js";

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
//
// Four independent facts have to hold, and they fail for different reasons, so
// each is reported separately rather than collapsed into one boolean:
//
//   schemaCompatible          the migration ledger is at the expected level
//   runtimeAccessHealthy      the runtime role holds the grants/policies it needs
//   authServingHealthy        the exact login/profile query actually executes
//   runtimeProvisioningCompatible
//                             the privilege *boundary* is intact (no role
//                             memberships, no excess grants, no extra callable
//                             functions, correct policy shape) and provisioning
//                             was re-run for the migration level now deployed
//
// The last one is what catches the deployment that migrated but never re-ran
// provision-db-roles.sql: the marker function still names the older migration,
// so readiness refuses even though every table exists.
router.get("/ready", async (req, res) => {
  try {
    const [compatibility, runtimeCompatibility] = await Promise.all([
      inspectSchemaCompatibility(pool),
      inspectRuntimeCompatibility(pool, { requireRuntimeRole: config.isProduction }),
    ]);
    const ready = compatibility.ready && runtimeCompatibility.runtimeProvisioningCompatible;
    const problems = [...compatibility.problems];
    if (!runtimeCompatibility.runtimeProvisioningCompatible) {
      const failed = Object.entries(runtimeCompatibility.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      problems.push(`the runtime privilege boundary is not intact (${failed.join(", ")})`);
    }
    res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: ready ? "ready" : "not_ready",
        backendRevision: config.buildRevision,
        ...compatibility,
        ready,
        problems,
        expectedRuntimeProvisioning: runtimeCompatibility.expectedRuntimeProvisioning,
        actualRuntimeProvisioning: runtimeCompatibility.actualRuntimeProvisioning,
        runtimeProvisioningCompatible: runtimeCompatibility.runtimeProvisioningCompatible,
        runtimeProvisioningChecks: runtimeCompatibility.checks,
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
        runtimeAccessHealthy: false,
        authServingHealthy: false,
        ready: false,
        problems: ["the database could not be reached or inspected"],
        expectedRuntimeProvisioning: EXPECTED_RUNTIME_PROVISIONING,
        actualRuntimeProvisioning: null,
        runtimeProvisioningCompatible: false,
      },
    });
  }
});

export default router;
