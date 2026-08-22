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

// Thrown when a Supabase Storage call is aborted by its own timeout —
// distinct from a plain network/HTTP failure so callers (and tests) can
// tell "we gave up waiting" apart from "the request completed and failed."
export class StorageTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Supabase Storage ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "StorageTimeoutError";
  }
}

// Server-generated storage keys (see generateStorageKey above) are already
// safe; a bucket name is operator-configured (env var), so it gets the
// same treatment as any other config value that ends up in a URL path —
// reject anything that isn't a plain, unambiguous name before it's ever
// used to build a request.
const SAFE_BUCKET_NAME = /^[a-zA-Z0-9._-]+$/;

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
  #timeoutMs;

  constructor({ url, serviceRoleKey, bucket, timeoutMs }) {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid SUPABASE_URL: "${url}".`);
    }

    if (!bucket || !SAFE_BUCKET_NAME.test(bucket)) {
      throw new Error(`Invalid SUPABASE_STORAGE_BUCKET: "${bucket}".`);
    }

    this.#baseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/$/, "");
    this.#bucket = bucket;
    this.#headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
    // Matches config/env.js's own default — kept here too so constructing
    // a provider directly (as the test suite does) without an explicit
    // timeoutMs still has a sane, safe bound rather than an
    // effectively-immediate setTimeout(fn, undefined).
    this.#timeoutMs = timeoutMs ?? 10_000;
  }

  #objectUrl(storageKey) {
    return `${this.#baseUrl}/storage/v1/object/${this.#bucket}/${storageKey}`;
  }

  // Bounds every request so a network/storage outage can't hold this call
  // — and any DB transaction/row lock a caller is holding alongside it —
  // open indefinitely. AbortController's reason isn't used in the thrown
  // error (it would just be a generic AbortError); the operation name and
  // configured timeout are enough to act on.
  async #fetchWithTimeout(url, options, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new StorageTimeoutError(operation, this.#timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async save(buffer, params) {
    const storageKey = generateStorageKey(params);

    const response = await this.#fetchWithTimeout(
      this.#objectUrl(storageKey),
      {
        method: "POST",
        headers: { ...this.#headers, "Content-Type": "application/octet-stream" },
        body: buffer,
      },
      "upload",
    );

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
    const response = await this.#fetchWithTimeout(
      this.#objectUrl(storageKey),
      { headers: this.#headers },
      "download",
    );

    if (!response.ok) {
      throw new Error(`Supabase Storage download failed (${response.status}): ${await response.text()}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  // Same never-throws contract as LocalStorageProvider.remove.
  async remove(storageKey) {
    try {
      const response = await this.#fetchWithTimeout(
        this.#objectUrl(storageKey),
        { method: "DELETE", headers: this.#headers },
        "delete",
      );

      if (!response.ok && response.status !== 404) {
        console.error(`Failed to clean up orphaned file ${storageKey}: HTTP ${response.status}`);
      }
    } catch (error) {
      console.error(`Failed to clean up orphaned file ${storageKey}:`, error.message);
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
      timeoutMs: source.supabaseStorageTimeoutMs,
    });
  }

  throw new Error(`Unknown STORAGE_PROVIDER "${source.storageProvider}" (expected "local" or "supabase").`);
}

export const storageService = createStorageService();
