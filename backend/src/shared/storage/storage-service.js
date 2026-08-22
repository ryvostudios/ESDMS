import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../../config/env.js";

// Interface: any provider must implement save(buffer, {gatePassId, category,
// extension}) -> {storageKey, checksumSha256, sizeBytes}, read(storageKey)
// -> Buffer, and remove(storageKey) -> void (never throws — see
// LocalStorageProvider.remove). Business/service code depends only on this
// shape, never on a specific backend, so swapping providers is a
// configuration change (STORAGE_PROVIDER), not a code change anywhere
// else.

// Filename is entirely server-generated (random uuid), never derived from
// a client-supplied filename — this is what prevents path traversal and
// filename-based attacks, and it's identical regardless of which provider
// actually stores the bytes.
function generateStorageKey({ gatePassId, category, extension }) {
  return path.posix.join("gate-pass", gatePassId, category, `${crypto.randomUUID()}.${extension}`);
}

function assertSafeLocalKey(storageKey) {
  const resolved = path.resolve(config.storageDir, storageKey);
  const root = path.resolve(config.storageDir);

  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("Unsafe storage key.");
  }

  return resolved;
}

// Development/test/local-demo only — see docs/SECURITY.md and
// config/env.js's validateProductionConfig. Render's (and most PaaS)
// filesystem is ephemeral: anything written here is gone on the next
// deploy or restart, which is unacceptable for Gate Pass evidence/PDFs
// that must persist for audit purposes.
export class LocalStorageProvider {
  async save(buffer, params) {
    const storageKey = generateStorageKey(params);
    const absolutePath = assertSafeLocalKey(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    return {
      storageKey,
      checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.length,
    };
  }

  async read(storageKey) {
    return fs.readFile(assertSafeLocalKey(storageKey));
  }

  // Compensating cleanup for a file whose owning DB write failed after the
  // bytes already landed on disk — never throws, so it can never mask the
  // original error the caller is already unwinding from.
  async remove(storageKey) {
    try {
      await fs.unlink(assertSafeLocalKey(storageKey));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Failed to clean up orphaned file ${storageKey}:`, error);
      }
    }
  }
}

// Production-ready private storage. Talks to Supabase Storage's plain HTTP
// API directly (rather than pulling in @supabase/supabase-js) — uploading,
// downloading, and deleting one object each map to one REST call, so a
// full SDK dependency buys nothing here. The service-role key is a secret
// (see docs/SECURITY.md) and is used only server-side, in this one file —
// it must never reach the frontend, and nothing here ever generates a
// public URL from it.
export class SupabaseStorageProvider {
  #baseUrl;
  #bucket;
  #headers;

  constructor({ url, serviceRoleKey, bucket }) {
    this.#baseUrl = url.replace(/\/$/, "");
    this.#bucket = bucket;
    this.#headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
  }

  #objectUrl(storageKey) {
    return `${this.#baseUrl}/storage/v1/object/${this.#bucket}/${storageKey}`;
  }

  async save(buffer, params) {
    const storageKey = generateStorageKey(params);

    const response = await fetch(this.#objectUrl(storageKey), {
      method: "POST",
      headers: { ...this.#headers, "Content-Type": "application/octet-stream" },
      body: buffer,
    });

    if (!response.ok) {
      throw new Error(`Supabase Storage upload failed (${response.status}): ${await response.text()}`);
    }

    return {
      storageKey,
      checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.length,
    };
  }

  async read(storageKey) {
    const response = await fetch(this.#objectUrl(storageKey), { headers: this.#headers });

    if (!response.ok) {
      throw new Error(`Supabase Storage download failed (${response.status}): ${await response.text()}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  // Same never-throws contract as LocalStorageProvider.remove.
  async remove(storageKey) {
    try {
      const response = await fetch(this.#objectUrl(storageKey), { method: "DELETE", headers: this.#headers });

      if (!response.ok && response.status !== 404) {
        console.error(`Failed to clean up orphaned file ${storageKey}: HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(`Failed to clean up orphaned file ${storageKey}:`, error);
    }
  }
}

// Takes an explicit config so tests can exercise the selection logic
// itself without needing to reload the real config module under different
// environment variables (see test/storage-service.test.js).
export function createStorageService(source = config) {
  // "local-single-instance-accepted-risk" (see config/env.js) is
  // functionally identical to "local" — it exists only so
  // validateProductionConfig can distinguish "defaulted to local by
  // accident" (refused) from "deliberately chose local in production"
  // (allowed through).
  if (source.storageProvider === "local" || source.storageProvider === "local-single-instance-accepted-risk") {
    return new LocalStorageProvider();
  }

  if (source.storageProvider === "supabase") {
    return new SupabaseStorageProvider({
      url: source.supabaseUrl,
      serviceRoleKey: source.supabaseServiceRoleKey,
      bucket: source.supabaseStorageBucket,
    });
  }

  throw new Error(`Unknown STORAGE_PROVIDER "${source.storageProvider}" (expected "local" or "supabase").`);
}

export const storageService = createStorageService();
