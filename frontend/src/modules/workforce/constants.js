// Mirrors backend/src/modules/employees/employees.service.js's
// ALLOWED_STATUS_TRANSITIONS status set — kept in sync manually, same
// pattern as gate-pass/constants.js. The server remains authoritative.
export const EMPLOYEE_STATUSES = ["ACTIVE", "INACTIVE", "RESIGNED", "TERMINATED"];

export const EMPLOYEE_STATUS_TONE = {
  ACTIVE: "success",
  INACTIVE: "neutral",
  RESIGNED: "warning",
  TERMINATED: "danger",
};
