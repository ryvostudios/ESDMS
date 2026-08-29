import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./fleet.controller.js";

// Two routers rather than one mixed router: /drivers and /vehicles are
// separate resources with separate permissions, and keeping them apart means
// a permission change to one can never widen the other by accident.
export const driverRouter = Router();
driverRouter.use(authenticate);
driverRouter.param("id", validateUuidParam("id"));
driverRouter.get("/", requirePermission("driver.view", "driver.manage"), controller.listDrivers);
driverRouter.get("/:id", requirePermission("driver.view", "driver.manage"), controller.getDriver);
driverRouter.post("/", requirePermission("driver.manage"), controller.createDriver);
driverRouter.patch("/:id", requirePermission("driver.manage"), controller.updateDriver);

export const vehicleRouter = Router();
vehicleRouter.use(authenticate);
vehicleRouter.param("id", validateUuidParam("id"));
vehicleRouter.get("/", requirePermission("vehicle.view", "vehicle.manage"), controller.listVehicles);
vehicleRouter.get("/:id", requirePermission("vehicle.view", "vehicle.manage"), controller.getVehicle);
vehicleRouter.post("/", requirePermission("vehicle.manage"), controller.createVehicle);
vehicleRouter.patch("/:id", requirePermission("vehicle.manage"), controller.updateVehicle);
