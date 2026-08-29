import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./gate-pass.service.js";
import { toGuardDto } from "./gate-pass.serializers.js";
import { extractPhoto, extractPhotos } from "./gate-pass.upload.js";
import {
  addEvidenceSchema,
  exitActionSchema,
  returnActionSchema,
  guardSearchQuerySchema,
  guardVerifySchema,
} from "./gate-pass.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ValidationError("Invalid request.", parsed.error.flatten());
  }

  return parsed.data;
}

export const dashboard = asyncHandler(async (req, res) => {
  const result = await service.getGuardDashboard(req.user);

  res.status(200).json({
    success: true,
    data: {
      newlyApproved: result.newlyApproved.map(toGuardDto),
      vehiclesOutside: result.vehiclesOutside.map(toGuardDto),
      recentActivity: result.recentActivity.map(toGuardDto),
    },
  });
});

export const search = asyncHandler(async (req, res) => {
  const { query } = parseBody(guardSearchQuerySchema, req.query);
  const rows = await service.searchForGuard(req.user, query);

  res.status(200).json({ success: true, data: rows.map(toGuardDto) });
});

export const getById = asyncHandler(async (req, res) => {
  const gatePass = await service.getGuardGatePass(req.user, req.params.id);

  res.status(200).json({ success: true, data: toGuardDto(gatePass) });
});

export const verify = asyncHandler(async (req, res) => {
  // POST with the token in the body, not GET with it in the URL — a raw
  // verification token in a URL path/query would be captured by ordinary
  // server/proxy access logs and browser history. The comparison itself is
  // already hashed server-side (see gate-pass.service.js hashToken).
  const { token } = parseBody(guardVerifySchema, req.body);
  const result = await service.getVerificationDetail(req.user, token);

  res.status(200).json({
    success: true,
    data: {
      gatePass: toGuardDto(result.gatePass),
      allowedAction: result.allowedAction,
      reason: result.reason,
    },
  });
});

export const exit = asyncHandler(async (req, res) => {
  const { odometer } = parseBody(exitActionSchema, req.body);
  const photos = extractPhotos(req);

  if (!photos.length) {
    throw new ValidationError("A departure photo is required.");
  }

  await service.recordExit(req.user, req.params.id, { odometer, photos });
  res.status(200).json({
    success: true,
    data: { id: req.params.id, status: "VEHICLE_OUTSIDE", photoCount: photos.length },
  });
});

export const returnVehicle = asyncHandler(async (req, res) => {
  const { odometer, remarks } = parseBody(returnActionSchema, req.body);
  const photos = extractPhotos(req);

  if (!photos.length) {
    throw new ValidationError("A return photo is required.");
  }

  await service.recordReturn(req.user, req.params.id, { odometer, photos, remarks });
  res.status(200).json({
    success: true,
    data: { id: req.params.id, status: "COMPLETED", photoCount: photos.length },
  });
});

export const addEvidence = asyncHandler(async (req, res) => {
  const { kind, note } = parseBody(addEvidenceSchema, req.body);
  const photos = extractPhotos(req);

  if (!photos.length) {
    throw new ValidationError("At least one photo is required.");
  }

  const result = await service.addEvidence(req.user, req.params.id, { kind, note: note || null, photos });
  res.status(201).json({ success: true, data: { id: req.params.id, ...result } });
});

export const listEvidence = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listEvidence(req.user, req.params.id) });
});
