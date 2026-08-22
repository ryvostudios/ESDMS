// Test-only fixture: loads config/env.js (which validates/canonicalizes
// at import time) and prints the fields config-validation.test.js needs
// to assert on, since env.js itself has no output on success and
// validate-only spawned-process tests can only see exit code + stderr.
import config from "../../src/config/env.js";

process.stdout.write(
  JSON.stringify({
    frontendOrigins: config.frontendOrigins,
    appPublicUrl: config.appPublicUrl,
    apiPublicUrl: config.apiPublicUrl,
  }),
);
