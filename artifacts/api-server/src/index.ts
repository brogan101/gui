import { logger } from "./lib/logger.js";
import app from "./app.js";

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Express 5 / Node net.Server: the listen callback fires only on success.
// Errors (EADDRINUSE etc.) are emitted as "error" events on the server.
const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

server.on("error", (err: Error) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
