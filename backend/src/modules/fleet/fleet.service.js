import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { employeeSiteFilter, resolveCreateSiteId } from "../workforce/workforce.authorization.js";
import * as repo from "./fleet.repository.js";

// Site is absolute for fleet master data, exactly as it is for Gate Passes
// (gate-pass.authorization.js): a wrong-site id is reported as "not found",
// never as "forbidden", so one site cannot probe another site's Driver or
// Vehicle list by id.
function assertWithinScope(actor, row, label) {
  const scope = employeeSiteFilter(actor);
  if (scope !== null && row.site_id !== scope) {
    throw new NotFoundError(`${label} not found.`);
  }
}

async function loadDriver(actor, id) {
  const driver = await repo.findDriverById(id);
  if (!driver) throw new NotFoundError("Driver not found.");
  assertWithinScope(actor, driver, "Driver");
  return driver;
}

async function loadVehicle(actor, id) {
  const vehicle = await repo.findVehicleById(id);
  if (!vehicle) throw new NotFoundError("Vehicle not found.");
  assertWithinScope(actor, vehicle, "Vehicle");
  return vehicle;
}

function listScope(actor, requestedSiteId) {
  const scope = employeeSiteFilter(actor);
  // A company-wide actor may narrow to one site; a site-bound actor's own
  // site always wins over whatever the query string asked for.
  if (scope === null) return requestedSiteId || null;
  return scope;
}

// An employee link is optional and must stay within the driver's own site:
// linking across sites would leak one site's workforce into another's master
// data. It grants the employee no authority — see the migration comment.
async function assertEmployeeLinkUsable(employeeId, siteId) {
  if (!employeeId) return;
  const employee = await repo.findEmployeeSite(employeeId);
  if (!employee || employee.primary_site_id !== siteId) {
    throw new ValidationError("Invalid employee link.");
  }
}

// Postgres raises 23505 for the partial/expression unique indexes this module
// relies on. Translating here keeps the friendly message in one place instead
// of pre-checking each field with its own racy SELECT.
function translateUniqueViolation(error, kind) {
  if (error?.code !== "23505") throw error;

  if (error.constraint === "vehicles_site_registration_key") {
    throw new ConflictError("A vehicle with this registration already exists at this site.");
  }
  if (error.constraint === "drivers_site_cnic_key") {
    throw new ConflictError("A driver with this CNIC already exists at this site.");
  }
  if (error.constraint === "drivers_site_licence_key") {
    throw new ConflictError("A driver with this licence number already exists at this site.");
  }
  throw new ConflictError(`This ${kind} conflicts with an existing record at this site.`);
}

export async function listDrivers(actor, query) {
  return repo.listDrivers({
    siteId: listScope(actor, query.siteId),
    search: query.search || null,
    includeInactive: query.includeInactive === "true",
  });
}

export async function getDriver(actor, id) {
  const driver = await loadDriver(actor, id);
  const gatePasses = await repo.listGatePassHistory({ driverId: id });
  return { driver, gatePasses };
}

export async function createDriver(actor, input) {
  const siteId = resolveCreateSiteId(actor, input.siteId, "drivers");
  await assertEmployeeLinkUsable(input.employeeId, siteId);

  try {
    return await repo.insertDriver({ ...input, siteId, createdByUserId: actor.id });
  } catch (error) {
    return translateUniqueViolation(error, "driver");
  }
}

export async function updateDriver(actor, id, input) {
  const driver = await loadDriver(actor, id);
  if (input.employeeId !== undefined) {
    await assertEmployeeLinkUsable(input.employeeId, driver.site_id);
  }

  try {
    return await repo.updateDriverFields(id, input);
  } catch (error) {
    return translateUniqueViolation(error, "driver");
  }
}

export async function listVehicles(actor, query) {
  return repo.listVehicles({
    siteId: listScope(actor, query.siteId),
    search: query.search || null,
    includeInactive: query.includeInactive === "true",
  });
}

export async function getVehicle(actor, id) {
  const vehicle = await loadVehicle(actor, id);
  const gatePasses = await repo.listGatePassHistory({ vehicleId: id });
  return { vehicle, gatePasses };
}

export async function createVehicle(actor, input) {
  const siteId = resolveCreateSiteId(actor, input.siteId, "vehicles");

  try {
    return await repo.insertVehicle({ ...input, siteId, createdByUserId: actor.id });
  } catch (error) {
    return translateUniqueViolation(error, "vehicle");
  }
}

export async function updateVehicle(actor, id, input) {
  await loadVehicle(actor, id);

  try {
    return await repo.updateVehicleFields(id, input);
  } catch (error) {
    return translateUniqueViolation(error, "vehicle");
  }
}

// Used by Gate Pass creation to resolve a chosen master row into the
// immutable snapshot the Gate Pass stores. Only an ACTIVE, same-site row may
// be attached to a new pass; an archived Driver stays readable on the old
// passes that already reference it.
export async function resolveDriverForGatePass(actor, driverId) {
  const driver = await loadDriver(actor, driverId);
  if (!driver.is_active) {
    throw new ValidationError("This driver is inactive and cannot be used on a new Gate Pass.");
  }
  return driver;
}

export async function resolveVehicleForGatePass(actor, vehicleId) {
  const vehicle = await loadVehicle(actor, vehicleId);
  if (!vehicle.is_active) {
    throw new ValidationError("This vehicle is inactive and cannot be used on a new Gate Pass.");
  }
  return vehicle;
}
