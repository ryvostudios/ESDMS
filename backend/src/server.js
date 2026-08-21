import config from "./config/env.js";
import app from "./app.js";
import { checkDatabaseConnection } from "./config/database.js";

async function startServer() {
  try {
    await checkDatabaseConnection();
    console.log("PostgreSQL connected");

    const server = app.listen(config.port, "127.0.0.1", () => {
      console.log(`E-Set API running on http://127.0.0.1:${config.port}`);
    });

    function shutdown(signal) {
      console.log(`${signal} received. Shutting down.`);

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
