import * as api from "./api.js";

// Field/column descriptions for the two master screens. Driver and Vehicle
// are the same screen — a searchable, site-scoped list with add/edit and a
// confirmed deactivate/reactivate — so they share one component and differ
// only by this config. Kept out of the component file so fast refresh keeps
// working there.

export const DRIVER_CONFIG = {
  key: "driver",
  title: "Drivers",
  subtitle: "Reusable driver master data for Gate Passes at your site.",
  managePermission: "driver.manage",
  viewPermission: "driver.view",
  list: api.listDrivers,
  create: api.createDriver,
  update: api.updateDriver,
  label: (row) => row.name,
  columns: [
    { header: "Name", render: (row) => row.name },
    { header: "Phone", render: (row) => row.phone },
    { header: "Company", render: (row) => row.company || "—" },
    { header: "Type", render: (row) => row.driver_type },
    { header: "Licence", render: (row) => row.licence_number || "—" },
  ],
  fields: [
    { name: "name", label: "Full name", required: true, maxLength: 150 },
    { name: "phone", label: "Phone", required: true, maxLength: 30 },
    { name: "cnic", label: "CNIC / national ID", maxLength: 30 },
    { name: "licenceNumber", label: "Driving licence number", maxLength: 50, column: "licence_number" },
    { name: "licenceExpiry", label: "Licence expiry", type: "date", column: "licence_expiry" },
    { name: "company", label: "Company / contractor / vendor", maxLength: 150 },
    {
      name: "driverType",
      label: "Driver type",
      type: "select",
      column: "driver_type",
      options: ["COMPANY", "CONTRACTOR", "VENDOR"],
    },
    { name: "notes", label: "Notes", type: "textarea", maxLength: 2000 },
  ],
};

export const VEHICLE_CONFIG = {
  key: "vehicle",
  title: "Vehicles",
  subtitle: "Reusable vehicle master data for Gate Passes at your site.",
  managePermission: "vehicle.manage",
  viewPermission: "vehicle.view",
  list: api.listVehicles,
  create: api.createVehicle,
  update: api.updateVehicle,
  label: (row) => row.registration_number,
  columns: [
    { header: "Registration", render: (row) => row.registration_number },
    { header: "Type", render: (row) => row.vehicle_type },
    { header: "Make", render: (row) => row.make || "—" },
    { header: "Model", render: (row) => row.model || "—" },
    { header: "Owner", render: (row) => row.owner_company || "—" },
  ],
  fields: [
    {
      name: "registrationNumber",
      label: "Registration number",
      required: true,
      maxLength: 30,
      column: "registration_number",
    },
    {
      name: "vehicleType",
      label: "Vehicle type",
      type: "select",
      column: "vehicle_type",
      options: ["TRUCK", "PICKUP", "VAN", "CAR", "BUS", "TRAILER", "BIKE", "OTHER"],
    },
    { name: "make", label: "Make", maxLength: 60 },
    { name: "model", label: "Model", maxLength: 60 },
    { name: "color", label: "Colour", maxLength: 40 },
    { name: "ownerCompany", label: "Company / owner", maxLength: 150, column: "owner_company" },
    { name: "notes", label: "Notes", type: "textarea", maxLength: 2000 },
  ],
};
