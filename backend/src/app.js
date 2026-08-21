import express from "express";
import cors from "cors";
import helmet from "helmet";
import config from "./config/env.js";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import gatePassRoutes from "./modules/gate-pass/gate-pass.routes.js";
import departmentRoutes from "./modules/departments/departments.routes.js";
import notificationRoutes from "./shared/notifications/notifications.routes.js";
import { apiRateLimiter } from "./middleware/rate-limit.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { ForbiddenError } from "./shared/errors/app-error.js";

const app = express();

app.use(helmet());

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
app.use(express.json({ limit: "1mb" }));
app.use(apiRateLimiter);

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/gate-passes", gatePassRoutes);
app.use("/api/v1/departments", departmentRoutes);
app.use("/api/v1/notifications", notificationRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
