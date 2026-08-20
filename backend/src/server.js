import app from "./app.js";

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`E-Set API running on http://127.0.0.1:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));