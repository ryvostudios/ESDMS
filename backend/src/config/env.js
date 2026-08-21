import "dotenv/config";

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseOrigins(value) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || "development";
const jwtSecret = required("JWT_SECRET");

if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

const frontendOrigins = parseOrigins(required("FRONTEND_ORIGIN"));

export const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  frontendOrigins,
  // Base URL embedded in Gate Pass QR codes as a deep link. Defaults to the
  // first allowed frontend origin when not set explicitly.
  appPublicUrl: process.env.APP_PUBLIC_URL || frontendOrigins[0],
  storageDir: process.env.STORAGE_DIR || "./storage",
};

export default config;
