import config from "./config/env.js";
import app from "./app.js";
import { checkDatabaseConnection } from "./config/database.js";
import { startOutboxProcessor } from "./shared/notifications/outbox.processor.js";

async function startServer() {
  try {
    await checkDatabaseConnection();
    console.log("PostgreSQL connected");

    const server = app.listen(config.port, "127.0.0.1", () => {
      console.log(`E-Set API running on http://127.0.0.1:${config.port}`);
    });

    const stopOutboxProcessor = startOutboxProcessor();

    function shutdown(signal) {
      console.log(`${signal} received. Shutting down.`);

      stopOutboxProcessor();
      server.close(() => {
        process.exit(0);
      });
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to connect to PostgreSQL:", error.message);
    process.exit(1);
  }
}

startServer();
