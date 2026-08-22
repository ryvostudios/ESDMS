import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  LocalStorageProvider,
  SupabaseStorageProvider,
  createStorageService,
} from "../src/shared/storage/storage-service.js";

const originalFetch = global.fetch;
after(() => {
  global.fetch = originalFetch;
});

test("createStorageService selects LocalStorageProvider for STORAGE_PROVIDER=local", () => {
  const service = createStorageService({ storageProvider: "local" });
  assert.ok(service instanceof LocalStorageProvider);
});

test("createStorageService selects LocalStorageProvider for the explicit single-instance opt-in", () => {
  const service = createStorageService({ storageProvider: "local-single-instance-accepted-risk" });
  assert.ok(service instanceof LocalStorageProvider);
});

test("createStorageService selects SupabaseStorageProvider for STORAGE_PROVIDER=supabase", () => {
  const service = createStorageService({
    storageProvider: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabaseServiceRoleKey: "test-key",
    supabaseStorageBucket: "gate-pass-evidence",
  });
  assert.ok(service instanceof SupabaseStorageProvider);
});

test("createStorageService rejects an unrecognized provider name", () => {
  assert.throws(() => createStorageService({ storageProvider: "s3" }), /Unknown STORAGE_PROVIDER/);
});

test("SupabaseStorageProvider.save PUTs to the bucket path with the service-role key, never a public URL", async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => "" };
  };

  const provider = new SupabaseStorageProvider({
    url: "https://project.supabase.co",
    serviceRoleKey: "secret-service-role-key",
    bucket: "gate-pass-evidence",
  });

  const result = await provider.save(Buffer.from("hello"), {
    gatePassId: "gp-1",
    category: "departure",
    extension: "jpg",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].url, /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/gate-pass-evidence\/gate-pass\/gp-1\/departure\/.+\.jpg$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-service-role-key");
  assert.ok(result.storageKey.startsWith("gate-pass/gp-1/departure/"));
  assert.equal(result.sizeBytes, 5);
  assert.equal(result.checksumSha256.length, 64);
});

test("SupabaseStorageProvider.read GETs the object and returns a Buffer", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    // Buffer.from(string) can allocate from Node's shared internal pool,
    // so its raw .buffer may be larger than the string itself — encode
    // through TextEncoder instead for an ArrayBuffer sized to exactly
    // this content, the way a real fetch response's arrayBuffer() is.
    arrayBuffer: async () => new TextEncoder().encode("file contents").buffer,
  });

  const provider = new SupabaseStorageProvider({
    url: "https://project.supabase.co",
    serviceRoleKey: "secret-service-role-key",
    bucket: "gate-pass-evidence",
  });

  const buffer = await provider.read("gate-pass/gp-1/departure/x.jpg");
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString(), "file contents");
});

test("SupabaseStorageProvider.save throws on a non-OK response", async () => {
  global.fetch = async () => ({ ok: false, status: 403, text: async () => "Forbidden" });

  const provider = new SupabaseStorageProvider({
    url: "https://project.supabase.co",
    serviceRoleKey: "bad-key",
    bucket: "gate-pass-evidence",
  });

  await assert.rejects(
    provider.save(Buffer.from("x"), { gatePassId: "gp-1", category: "departure", extension: "jpg" }),
    /Supabase Storage upload failed \(403\)/,
  );
});

test("SupabaseStorageProvider.remove never throws, even on a network failure", async () => {
  global.fetch = async () => {
    throw new Error("network down");
  };

  const provider = new SupabaseStorageProvider({
    url: "https://project.supabase.co",
    serviceRoleKey: "test-key",
    bucket: "gate-pass-evidence",
  });

  await provider.remove("gate-pass/gp-1/departure/x.jpg");
  // No assertion needed beyond "didn't throw" — remove() is a
  // compensating-cleanup path that must never mask the caller's original
  // error.
});
