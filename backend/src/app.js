import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import config from "./config/env.js";
import healthRoutes from "./routes/health.routes.js";
import cmsRoutes from "./modules/cms/cms.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import gatePassRoutes from "./modules/gate-pass/gate-pass.routes.js";
import departmentRoutes from "./modules/departments/departments.routes.js";
import userRoutes from "./modules/users/users.routes.js";
import positionRoutes from "./modules/positions/positions.routes.js";
import { driverRouter, vehicleRouter } from "./modules/fleet/fleet.routes.js";
import employmentTypeRoutes from "./modules/employment-types/employment-types.routes.js";
import employeeRoutes from "./modules/employees/employees.routes.js";
import workforceConfigRoutes from "./modules/workforce-config/workforce-config.routes.js";
import profileRoutes from "./modules/profile/profile.routes.js";
import documentRoutes from "./modules/documents/documents.routes.js";
import documentReportRoutes from "./modules/documents/documents-reports.routes.js";
import compensationRoutes from "./modules/compensation/compensation.routes.js";
import contractRoutes from "./modules/contracts/contracts.routes.js";
import { policyRouter as rotationPolicyRoutes, statusRouter as rotationStatusRoutes } from "./modules/rotation/rotation.routes.js";
import { typeRouter as leaveTypeRoutes, requestRouter as leaveRequestRoutes, approvalRouter as leaveApprovalRoutes } from "./modules/leave/leave.routes.js";
import businessHistoryRoutes from "./modules/workforce/business-history.routes.js";
import materialCatalogRoutes from "./modules/material-catalog/material-catalog.routes.js";
import materialDemandRoutes from "./modules/material-demand/material-demand.routes.js";
import procurementPricingRoutes from "./modules/procurement/procurement-pricing.routes.js";
import ipoRoutes from "./modules/ipo/ipo.routes.js";
import deliveryChallanRoutes from "./modules/delivery-challan/delivery-challan.routes.js";
import receivingRoutes from "./modules/receiving/receiving.routes.js";
import reportRoutes from "./modules/reports/reports.routes.js";
import procurementReportRoutes from "./modules/reports/procurement-reports.routes.js";
import notificationRoutes from "./shared/notifications/notifications.routes.js";
import { apiUnauthenticatedIpRateLimiter, apiAuthenticatedIpRateLimiter } from "./middleware/rate-limit.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { rejectUnsupportedText } from "./shared/http/text-safety.js";
import { ForbiddenError } from "./shared/errors/app-error.js";

const app = express();

// Must be set before anything reads req.ip (rate limiters, logging) or
// checks req.secure — an unset/blind trust-proxy config would let a client
// spoof X-Forwarded-For and either defeat IP-based rate limiting or make
// every request behind the real proxy look like it came from one IP.
app.set("trust proxy", config.trustProxyHops);

app.use(helmet());
app.use(cookieParser());

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin/non-browser requests (curl, health checks) send no
      // Origin header at all — allow those through; browsers always send it.
      if (!origin || config.frontendOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new ForbiddenError("Origin not allowed."));
    },
    credentials: true,
  }),
);

app.disable("x-powered-by");
// Parse all valid JSON values so endpoint validation, not the transport
// parser, decides whether `null`/arrays/primitives are valid request bodies.
app.use(express.json({ limit: "1mb", strict: false }));
// Immediately after parsing, before any route: a NUL byte in any query value
// or JSON string cannot be stored by PostgreSQL and used to surface as an
// unclassifiable 500 on every list, search and create endpoint. Rejecting it
// once here covers every current and future text field, rather than relying
// on ~26 validation modules each remembering to. Multipart text fields are
// covered where their upload middleware is defined (see text-safety.js).
app.use(rejectUnsupportedText);
// Coarse ceiling FIRST, unconditionally, for every request — no `skip`,
// no dependency on token validity. Closes a bypass: a token with a valid
// signature/expiry/issuer/audience but a revoked session_version or a
// deactivated user is cryptographically "valid" enough to skip the
// unauthenticated limiter below, yet authenticate.js still rejects it
// before it ever reaches the authenticated-only limiters — previously
// leaving it with NO rate-limit coverage at all. Applying this same ceiling
// globally guarantees every request, regardless of outcome, is covered by
// at least one meaningful bucket. See rate-limit.js for the full picture.
app.use(apiAuthenticatedIpRateLimiter);
app.use(apiUnauthenticatedIpRateLimiter);

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/gate-passes", gatePassRoutes);
app.use("/api/v1/cms", cmsRoutes);
app.use("/api/v1/departments", departmentRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/positions", positionRoutes);
app.use("/api/v1/drivers", driverRouter);
app.use("/api/v1/vehicles", vehicleRouter);
app.use("/api/v1/employment-types", employmentTypeRoutes);
app.use("/api/v1/employees", employeeRoutes);
app.use("/api/v1/employees/:id/profile", profileRoutes);
app.use("/api/v1/me/profile", profileRoutes);
app.use("/api/v1/employees/:id/documents", documentRoutes);
app.use("/api/v1/me/documents", documentRoutes);
app.use("/api/v1/documents", documentReportRoutes);
app.use("/api/v1/employees/:id/compensation", compensationRoutes);
app.use("/api/v1/me/compensation", compensationRoutes);
app.use("/api/v1/employees/:id/contracts", contractRoutes);
app.use("/api/v1/me/contracts", contractRoutes);
app.use("/api/v1/rotation-policies", rotationPolicyRoutes);
app.use("/api/v1/employees/:id/rotation", rotationStatusRoutes);
app.use("/api/v1/me/rotation", rotationStatusRoutes);
app.use("/api/v1/leave-types", leaveTypeRoutes);
app.use("/api/v1/employees/:id/leave", leaveRequestRoutes);
app.use("/api/v1/me/leave", leaveRequestRoutes);
app.use("/api/v1/leave", leaveApprovalRoutes);
app.use("/api/v1/employees/:id/history", businessHistoryRoutes);
app.use("/api/v1/me/history", businessHistoryRoutes);
app.use("/api/v1/material-catalog", materialCatalogRoutes);
app.use("/api/v1/demands", materialDemandRoutes);
app.use("/api/v1/procurement/pricing", procurementPricingRoutes);
app.use("/api/v1/ipos", ipoRoutes);
app.use("/api/v1/delivery-challans", deliveryChallanRoutes);
app.use("/api/v1/receiving", receivingRoutes);
app.use("/api/v1/reports/workforce", reportRoutes);
app.use("/api/v1/reports/procurement", procurementReportRoutes);
app.use("/api/v1/workforce-config", workforceConfigRoutes);
app.use("/api/v1/notifications", notificationRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
