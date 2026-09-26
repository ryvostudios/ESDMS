import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import sharp from "sharp";
import pool from "../src/config/database.js";
import config from "../src/config/env.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload } from "./gate-pass-helpers.js";
import { recordLayout } from "./pdf-layout-recorder.js";
import * as gatePassService from "../src/modules/gate-pass/gate-pass.service.js";
import { defaultLogoBytes, loadDocumentBranding } from "../src/shared/documents/branding.js";
import { generateGatePassPdf } from "../src/modules/gate-pass/gate-pass.pdf.js";
import { generateGatePassCompletionPdf } from "../src/modules/gate-pass/gate-pass.completion-pdf.js";
import { generateDeliveryChallanPdf } from "../src/modules/delivery-challan/delivery-challan.pdf.js";

let server;
let users;
let tokens;
const call = (token, method, apiPath, body, isForm) => apiRequest(server.baseUrl, method, `/api/v1${apiPath}`, { token, body, isForm });
const grant = (id, code, effect = "GRANT") => call(tokens.ceo, "PUT", `/users/${id}/permissions/${code}`, { effect });
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const logoDir = path.resolve(config.storageDir, "cms", "branding", "logo");
const storedLogos = () => (fs.existsSync(logoDir) ? fs.readdirSync(logoDir) : []);

// A real, minimal, fully decodable PNG of the given size (RGBA, all zero).
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function logoForm(buffer, { type = "image/png", filename = "logo.png", revision }) {
  const form = new FormData();
  form.append("revision", String(revision));
  form.append("logo", new Blob([buffer], { type }), filename);
  return form;
}

async function brandingRows(token = tokens.ceo) {
  const result = await call(token, "GET", "/cms/settings/branding");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return Object.fromEntries(result.body.data.map((row) => [row.key, row]));
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = ANY($1::uuid[])", [[users.siteManager, users.employee]]);
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    manager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
  };
});

after(async () => {
  // Leave the shared test database with default branding for other suites.
  const rows = await brandingRows();
  if (rows["company.logo"].logo.source !== "default") {
    await call(tokens.ceo, "DELETE", "/cms/branding/logo", { revision: rows["company.logo"].revision });
  }
  if (rows["company.app_icon"].logo.source !== "default") {
    await call(tokens.ceo, "DELETE", "/cms/branding/app-icon", { revision: rows["company.app_icon"].revision });
  }
  const name = rows["document.company_name"];
  if (name.value !== "E-Set Engineering Services") {
    await call(tokens.ceo, "PATCH", "/cms/settings/document.company_name", { value: "E-Set Engineering Services", revision: name.revision });
  }
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = ANY($1::uuid[])", [[users.siteManager, users.employee]]);
  await server.close();
  await pool.end();
});

test("application icon is square, decoded, CMS-authorized, audited and publicly versioned", async () => {
  let revision = (await brandingRows())["company.app_icon"].revision;
  const upload = (token, bytes, type = "image/png") => call(token, "PUT", "/cms/branding/app-icon",
    logoForm(bytes, { revision, type }), true);
  assert.equal((await upload(null, png(512, 512))).status, 401);
  assert.equal((await upload(tokens.employee, png(512, 512))).status, 403);
  assert.equal((await upload(tokens.ceo, png(511, 511))).status, 400);
  assert.equal((await upload(tokens.ceo, png(512, 600))).status, 400);
  assert.equal((await upload(tokens.ceo, Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 400);
  const saved = await upload(tokens.ceo, png(512, 512));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(!JSON.stringify(saved.body).includes('storageKey'));
  revision = saved.body.data.revision;
  const publicInfo = await call(null, "GET", "/cms/branding/public");
  assert.equal(publicInfo.status, 200);
  assert.match(publicInfo.body.data.appIconVersion, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(publicInfo.body).includes('storageKey'));

  for (const size of [32, 180, 192, 512]) {
    const response = await fetch(`${server.baseUrl}/api/v1/cms/branding/app-icon/${size}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const manifestResponse = await fetch(`${server.baseUrl}/api/v1/cms/branding/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type'), /^application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.ok(manifest.icons.every(icon => icon.src.includes(publicInfo.body.data.appIconVersion)));
  assert.ok(!JSON.stringify(manifest).includes('storageKey'));
  const audit = await pool.query("SELECT metadata FROM governance_audit_log WHERE action='CMS_SETTING_CHANGED' AND metadata->>'key'='company.app_icon' ORDER BY created_at DESC LIMIT 1");
  assert.ok(audit.rows.length);
  assert.ok(!JSON.stringify(audit.rows[0].metadata).includes('storageKey'));
  assert.equal((await call(tokens.ceo, "DELETE", "/cms/branding/app-icon", { revision })).status, 200);
  const fallback = await call(null, "GET", "/cms/branding/public");
  assert.equal(fallback.body.data.appIconVersion, null);
  assert.equal((await fetch(`${server.baseUrl}/api/v1/cms/branding/app-icon/192`)).status, 404);
});

test("branding changes require cms.branding.manage on the server; DENY wins; CEO protection is unaffected", async () => {
  const revision = (await brandingRows())["company.logo"].revision;
  const valid = logoForm(png(64, 64), { revision });

  assert.equal((await call(null, "PUT", "/cms/branding/logo", valid, true)).status, 401);
  for (const token of [tokens.employee, tokens.manager]) {
    assert.equal((await call(token, "GET", "/cms/settings/branding")).status, 403);
    assert.equal((await call(token, "PUT", "/cms/branding/logo", logoForm(png(64, 64), { revision }), true)).status, 403);
    assert.equal((await call(token, "DELETE", "/cms/branding/logo", { revision })).status, 403);
    assert.equal((await call(token, "PATCH", "/cms/settings/document.company_name", { value: "Not allowed", revision: 1 })).status, 403);
  }

  assert.equal((await grant(users.siteManager, "cms.branding.manage")).status, 200);
  const rows = await brandingRows(tokens.manager);
  const renamed = await call(tokens.manager, "PATCH", "/cms/settings/document.company_name", {
    value: "E-Set Engineering Services (Pvt) Ltd",
    revision: rows["document.company_name"].revision,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  // A branding grant confers nothing over users, least of all the CEO.
  assert.equal((await call(tokens.manager, "PUT", `/users/${users.ceo}/permissions/cms.branding.manage`, { effect: "DENY" })).status, 403);

  assert.equal((await grant(users.siteManager, "cms.branding.manage", "DENY")).status, 200);
  assert.equal(
    (await call(tokens.manager, "PATCH", "/cms/settings/document.company_name", { value: "Denied", revision: renamed.body.data.revision })).status,
    403,
  );
  assert.equal((await call(tokens.manager, "PUT", "/cms/branding/logo", logoForm(png(64, 64), { revision }), true)).status, 403);
});

test("branding text is validated and the managed logo setting cannot be written as text", async () => {
  const rows = await brandingRows();
  const patch = (key, value, revision = rows[key]?.revision ?? 1) => call(tokens.ceo, "PATCH", `/cms/settings/${key}`, { value, revision });

  assert.equal((await patch("document.company_name", "x".repeat(151))).status, 400);
  assert.equal((await patch("document.company_name", "   ")).status, 400);
  assert.equal((await patch("document.company_name", "<script>alert(1)</script>")).status, 400);
  assert.equal((await patch("company.contact_details", "x".repeat(501))).status, 400);
  assert.equal((await patch("company.unknown_branding", "x", 1)).status, 404);
  assert.equal((await patch("company.logo", '{"storageKey":"../../etc/passwd","sha256":"' + "a".repeat(64) + '"}')).status, 400);
  // The database allowlist is the backstop for any other write path.
  await assert.rejects(pool.query("INSERT INTO cms_settings(key,category,value) VALUES ('company.favicon','branding','x')"), /cms_settings_allowlist/);

  const saved = await patch("company.contact_details", "Lahore · info@eset.example");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await patch("company.contact_details", "", saved.body.data.revision);
});

test("logo uploads accept only real, decodable PNG/JPEG within limits, never trusting type or filename", async () => {
  let revision = (await brandingRows())["company.logo"].revision;
  const before = storedLogos().length;
  const upload = (buffer, options) => call(tokens.ceo, "PUT", "/cms/branding/logo", logoForm(buffer, { revision, ...options }), true);

  assert.equal((await upload(Buffer.from("MZ executable pretending to be a PNG"))).status, 400);
  assert.equal((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: "image/svg+xml", filename: "logo.svg" })).status, 400);
  const truncated = png(64, 64);
  assert.equal((await upload(truncated.subarray(0, truncated.length - 20))).status, 400);
  const corrupt = png(64, 64);
  corrupt.fill(0xab, 45, 60); // inside the compressed pixel data
  assert.equal((await upload(corrupt)).status, 400);
  assert.equal((await upload(png(8, 8))).status, 400, "too small to be a usable logo");
  assert.equal((await upload(Buffer.concat([png(64, 64), Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
  assert.equal(storedLogos().length, before, "a rejected upload stores nothing");

  // The filename is ignored entirely: the key is server-generated.
  const real = defaultLogoBytes();
  const accepted = await upload(real, { filename: "../../../../etc/passwd.png" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.match(accepted.body.data.logo.description, /^Uploaded PNG 353×402/);
  assert.ok(!JSON.stringify(accepted.body).includes("storageKey"));
  revision = accepted.body.data.revision;
  const files = storedLogos();
  assert.equal(files.length, before + 1);
  assert.ok(files.every((name) => /^[0-9a-f-]{36}\.(png|jpg)$/.test(name)), "server-generated names only");

  // What is stored and served is the canonical re-encoding of the pixels.
  const served = await fetch(`${server.baseUrl}/api/v1/cms/branding/logo`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  const servedMeta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
  const realMeta = await sharp(real).metadata();
  assert.deepEqual([servedMeta.format, servedMeta.width, servedMeta.height, servedMeta.hasAlpha],
    ["png", realMeta.width, realMeta.height, realMeta.hasAlpha]);

  // Stale revision: rejected, and the bytes it just wrote are cleaned up.
  const stale = await call(tokens.ceo, "PUT", "/cms/branding/logo", logoForm(png(64, 64), { revision: revision - 1 }), true);
  assert.equal(stale.status, 409);
  assert.equal(storedLogos().length, before + 1);

  const audit = await pool.query(
    "SELECT metadata FROM governance_audit_log WHERE action='CMS_SETTING_CHANGED' AND metadata->>'key'='company.logo' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(audit.rows[0].metadata.before, "Default E-Set logo");
  assert.match(audit.rows[0].metadata.after, /^Uploaded PNG 353×402, \d+ KB, sha256 [0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(audit.rows[0].metadata).includes("cms/branding"), "no storage path in audit");

  const reset = await call(tokens.ceo, "DELETE", "/cms/branding/logo", { revision });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.data.logo.source, "default");
});

test("A04: logos are fully decoded, type-checked against their bytes and canonically re-encoded", async () => {
  let revision = (await brandingRows())["company.logo"].revision;
  const before = storedLogos().length;
  const upload = (buffer, options) => call(tokens.ceo, "PUT", "/cms/branding/logo", logoForm(buffer, { revision, ...options }), true);
  const image = (width, height, format, background = { r: 20, g: 90, b: 160, alpha: 1 }) =>
    sharp({ create: { width, height, channels: 4, background } })[format]().toBuffer();
  const jpeg = await image(200, 100, "jpeg");

  // Truncated JPEG that still starts with SOI and ends with EOI.
  const truncatedJpeg = Buffer.concat([jpeg.subarray(0, Math.floor(jpeg.length / 2)), Buffer.from([0xff, 0xd9])]);
  assert.equal((await upload(truncatedJpeg, { type: "image/jpeg", filename: "logo.jpg" })).status, 400);
  // Declared type must match the decoded bytes, whatever the filename says.
  assert.equal((await upload(jpeg, { type: "image/png" })).status, 400, "JPEG declared as PNG");
  assert.equal((await upload(await image(64, 64, "png"), { type: "image/jpeg", filename: "logo.jpg" })).status, 400, "PNG declared as JPEG");
  const webp = await image(64, 64, "webp");
  assert.equal((await upload(webp, { type: "image/png" })).status, 400, "WebP declared as PNG");
  assert.equal((await upload(webp, { type: "image/webp", filename: "logo.webp" })).status, 400, "WebP is not a supported format");
  // Malformed PNG: a valid header followed by garbage pixel data.
  const malformed = Buffer.from(await image(64, 64, "png"));
  malformed.fill(0x00, 40, malformed.length - 12);
  assert.equal((await upload(malformed)).status, 400);
  // Dimensions outside 32-4096 on either side.
  assert.equal((await upload(await image(4097, 32, "png"))).status, 400);
  assert.equal((await upload(await image(32, 31, "png"))).status, 400);
  assert.equal(storedLogos().length, before, "a rejected upload stores nothing");

  // Valid JPEG: accepted, stored as the canonical JPEG, trailing bytes and metadata dropped.
  const withTrailer = Buffer.concat([await sharp(jpeg).withMetadata({ exif: { IFD0: { Copyright: "synthetic" } } }).jpeg().toBuffer(),
    Buffer.from("<script>trailing payload</script>")]);
  let accepted = await upload(withTrailer, { type: "image/jpeg", filename: "logo.jpg" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.match(accepted.body.data.logo.description, /^Uploaded JPEG 200×100/);
  revision = accepted.body.data.revision;
  let served = Buffer.from(await (await fetch(`${server.baseUrl}/api/v1/cms/branding/logo`)).arrayBuffer());
  assert.ok(!served.includes("trailing payload"), "bytes after the image are not stored");
  const jpegMeta = await sharp(served).metadata();
  assert.deepEqual([jpegMeta.format, jpegMeta.width, jpegMeta.height, jpegMeta.exif], ["jpeg", 200, 100, undefined]);

  // Valid PNG with transparency: the alpha channel survives re-encoding.
  accepted = await upload(await image(120, 60, "png", { r: 0, g: 0, b: 0, alpha: 0.25 }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  revision = accepted.body.data.revision;
  served = Buffer.from(await (await fetch(`${server.baseUrl}/api/v1/cms/branding/logo`)).arrayBuffer());
  const pngMeta = await sharp(served).metadata();
  assert.deepEqual([pngMeta.format, pngMeta.width, pngMeta.height, pngMeta.hasAlpha], ["png", 120, 60, true]);
  const { data } = await sharp(served).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[3] > 0 && data[3] < 255, "partially transparent pixels stay partially transparent");
  assert.equal(storedLogos().length, before + 2);

  const reset = await call(tokens.ceo, "DELETE", "/cms/branding/logo", { revision });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
});

test("new documents carry the configured branding; missing optional branding never blocks generation", async () => {
  const brand = await loadDocumentBranding();
  assert.equal(brand.companyName, "E-Set Engineering Services (Pvt) Ltd");
  assert.equal(sha(brand.logo), sha(defaultLogoBytes()));

  const gatePass = {
    gate_pass_number: "ESD-2026-000900", status: "COMPLETED", site_name: "Main", created_at: new Date(), issuing_department_name: "Civil",
    requested_by: "Requester", destination: "Workshop", driver_name: "Driver", driver_phone: "+923001234567", vehicle_registration: "LES-1",
    job_order_id: null, purpose: "SAMPLE", expected_return_date: null, remarks: null, created_by_name: "Creator", approved_by_name: "Approver",
    approved_at: new Date(), departure_at: new Date(), departure_by_name: "Keeper", return_at: new Date(), return_by_name: "Keeper",
    return_remarks: null, departure_odometer: 100, return_odometer: 140, distance_km: 40,
  };
  const layoutOf = async (generate) => {
    const layout = recordLayout();
    try {
      await generate();
    } finally {
      layout.restore();
    }
    return layout;
  };

  const approval = await layoutOf(() => generateGatePassPdf(gatePass, [], "https://example.test/verify#t", brand));
  const header = approval.boxes.filter((box) => box.page === approval.boxes[0].page);
  assert.ok(header[0].kind === "image" && header[0].y === 40, "the logo leads the header");
  assert.ok(Math.abs(header[0].width / (header[0].bottom - header[0].y) - 353 / 402) < 0.01, "aspect ratio preserved");
  assert.ok(approval.boxes.some((box) => box.text === "E-Set Engineering Services (Pvt) Ltd"));
  assert.ok(approval.boxes.some((box) => box.text === "No material items"));
  assert.deepEqual(approval.overlaps(), []);

  // No logo, no contact details: text identity only, still a valid document.
  const textOnly = await layoutOf(() => generateGatePassCompletionPdf(gatePass, [], [], { ...brand, logo: null, contactDetails: "" }));
  assert.ok(!textOnly.boxes.some((box) => box.kind === "image"));
  assert.ok(textOnly.boxes.some((box) => box.text === "E-Set Engineering Services (Pvt) Ltd"));
  assert.equal(textOnly.boxes.filter((box) => box.text === "No photographic evidence was captured.").length, 2);
  assert.deepEqual(textOnly.overlaps(), []);

  // A configured logo whose bytes are unreadable is not replaced by another logo.
  await pool.query(
    "UPDATE cms_settings SET value=$1 WHERE key='company.logo'",
    [JSON.stringify({ storageKey: "cms/branding/logo/missing.png", sha256: "b".repeat(64), mimeType: "image/png", width: 1, height: 1, sizeBytes: 1 })],
  );
  try {
    assert.equal((await loadDocumentBranding()).logo, null);
    assert.equal((await fetch(`${server.baseUrl}/api/v1/cms/branding/logo`)).status, 404);
  } finally {
    await pool.query("UPDATE cms_settings SET value='' WHERE key='company.logo'");
  }

  // Branding never widens what a document shows: the Delivery Challan stays price-free.
  const challan = await layoutOf(() =>
    generateDeliveryChallanPdf(
      { deliveryChallan: { dc_number: "DC-1", status: "FINALIZED", finalized_at: new Date(), department_name: "Civil", site_name: "Main" }, lines: [{ line_no: 1, item_name_snapshot: "Cable", quantity: "1.00", uom_name_snapshot: "M", estimated_unit_price: "999.99" }] },
      brand,
    ),
  );
  assert.ok(challan.boxes.some((box) => box.kind === "image"));
  assert.ok(!challan.boxes.some((box) => /999\.99|price/i.test(box.text)));
});

test("an issued Gate Pass PDF keeps its bytes after branding changes", async () => {
  const created = await call(tokens.teamLead, "POST", "/gate-passes", buildCreatePayload({ issuingDepartmentId: users.departmentA }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal((await call(tokens.admin, "POST", `/gate-passes/${id}/approve`)).status, 200);
  const job = await pool.query("SELECT * FROM notification_outbox WHERE entity_id=$1 AND event_type='GENERATE_APPROVAL_PDF'", [id]);
  await gatePassService.processApprovalPdfJob(job.rows[0]);

  const download = async () => {
    const response = await fetch(`${server.baseUrl}/api/v1/gate-passes/${id}/pdf`, { headers: { Cookie: tokens.admin } });
    assert.equal(response.status, 200);
    return sha(Buffer.from(await response.arrayBuffer()));
  };
  const issued = await download();

  const rows = await brandingRows();
  assert.equal((await call(tokens.ceo, "PATCH", "/cms/settings/document.company_name", { value: "Renamed Issuer", revision: rows["document.company_name"].revision })).status, 200);
  const uploaded = await call(tokens.ceo, "PUT", "/cms/branding/logo", logoForm(png(120, 60), { revision: rows["company.logo"].revision }), true);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));

  assert.equal(await download(), issued, "historical PDF bytes are unchanged");
  const brand = await loadDocumentBranding();
  assert.equal(brand.companyName, "Renamed Issuer", "new documents use the current branding");
  const logo = await sharp(brand.logo).metadata();
  assert.deepEqual([logo.format, logo.width, logo.height], ["png", 120, 60], "new documents use the uploaded logo, canonically re-encoded");
});
