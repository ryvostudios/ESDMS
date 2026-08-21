import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./gate-pass.service.js";
import { toGuardDto } from "./gate-pass.serializers.js";
import { extractPhoto } from "./gate-pass.upload.js";
import { exitActionSchema, returnActionSchema, guardSearchQuerySchema } from "./gate-pass.validation.js";

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
  const rows = await service.searchForGuard(query);

  res.status(200).json({ success: true, data: rows.map(toGuardDto) });
});

export const verify = asyncHandler(async (req, res) => {
  const result = await service.getVerificationDetail(req.params.token);

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
  const photo = extractPhoto(req);

  if (!photo) {
    throw new ValidationError("A departure photo is required.");
  }

  await service.recordExit(req.user, req.params.id, { odometer, photo });
  res.status(200).json({ success: true, data: { id: req.params.id, status: "VEHICLE_OUTSIDE" } });
});

export const returnVehicle = asyncHandler(async (req, res) => {
  const { odometer, remarks } = parseBody(returnActionSchema, req.body);
  const photo = extractPhoto(req);

  if (!photo) {
    throw new ValidationError("A return photo is required.");
  }

  await service.recordReturn(req.user, req.params.id, { odometer, photo, remarks });
  res.status(200).json({ success: true, data: { id: req.params.id, status: "COMPLETED" } });
});
