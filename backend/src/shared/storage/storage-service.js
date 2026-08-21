import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../config/env.js";

// Interface: any provider must implement save(buffer, {gatePassId, category,
// extension}) -> {storageKey, checksumSha256, sizeBytes} and
// read(storageKey) -> Buffer. Business/service code depends only on this
// shape, never on the filesystem directly, so swapping in an S3-compatible
// provider later is a one-file change.

function assertSafeKey(storageKey) {
  const resolved = path.resolve(config.storageDir, storageKey);
  const root = path.resolve(config.storageDir);

  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("Unsafe storage key.");
  }

  return resolved;
}

export class LocalStorageProvider {
  async save(buffer, { gatePassId, category, extension }) {
    // Filename is entirely server-generated (random uuid), never derived
    // from a client-supplied filename — this is what prevents path
    // traversal and filename-based attacks.
    const storageKey = path.posix.join(
      "gate-pass",
      gatePassId,
      category,
      `${crypto.randomUUID()}.${extension}`,
    );

    const absolutePath = assertSafeKey(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    return {
      storageKey,
      checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.length,
    };
  }

  async read(storageKey) {
    return fs.readFile(assertSafeKey(storageKey));
  }
}

export const storageService = new LocalStorageProvider();
