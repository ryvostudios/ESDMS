import express from "express";
import healthRoutes from "./routes/health.routes.js";
import cors from "cors";

const app = express();
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  }),
);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use("/api/v1/health", healthRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found.",
    },
  });
});

export default app;