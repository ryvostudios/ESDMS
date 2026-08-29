import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./fleet.service.js";
import {
  createDriverSchema,
  createVehicleSchema,
  fleetListQuerySchema,
  updateDriverSchema,
  updateVehicleSchema,
} from "./fleet.validation.js";

function parse(schema, payload) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const listDrivers = asyncHandler(async (req, res) => {
  const query = parse(fleetListQuerySchema, req.query);
  res.status(200).json({ success: true, data: await service.listDrivers(req.user, query) });
});

export const getDriver = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getDriver(req.user, req.params.id) });
});

export const createDriver = asyncHandler(async (req, res) => {
  const input = parse(createDriverSchema, req.body);
  res.status(201).json({ success: true, data: await service.createDriver(req.user, input) });
});

export const updateDriver = asyncHandler(async (req, res) => {
  const input = parse(updateDriverSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateDriver(req.user, req.params.id, input) });
});

export const listVehicles = asyncHandler(async (req, res) => {
  const query = parse(fleetListQuerySchema, req.query);
  res.status(200).json({ success: true, data: await service.listVehicles(req.user, query) });
});

export const getVehicle = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getVehicle(req.user, req.params.id) });
});

export const createVehicle = asyncHandler(async (req, res) => {
  const input = parse(createVehicleSchema, req.body);
  res.status(201).json({ success: true, data: await service.createVehicle(req.user, input) });
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const input = parse(updateVehicleSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateVehicle(req.user, req.params.id, input) });
});
