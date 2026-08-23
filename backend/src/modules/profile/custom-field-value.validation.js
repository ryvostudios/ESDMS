import { ValidationError } from "../../shared/errors/app-error.js";

// Structural validation for one custom field's value against its own
// field_type + validation config — independent of the fixed Employee
// schema, and never a code path into salary/contract/permission logic
// (see workforce-config.validation.js's reserved-key denylist for the
// other half of that guarantee).
export function validateCustomFieldValue(field, value) {
  const v = field.validation || {};

  if (value === null || value === undefined) {
    if (field.is_required) throw new ValidationError(`${field.label} is required.`);
    return null;
  }

  switch (field.field_type) {
    case "TEXT":
    case "LONG_TEXT": {
      if (typeof value !== "string") throw new ValidationError(`${field.label} must be text.`);
      if (v.minLength !== undefined && value.length < v.minLength) throw new ValidationError(`${field.label} is too short.`);
      if (v.maxLength !== undefined && value.length > v.maxLength) throw new ValidationError(`${field.label} is too long.`);
      return value;
    }
    case "EMAIL": {
      if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new ValidationError(`${field.label} must be a valid email.`);
      }
      return value;
    }
    case "URL": {
      if (typeof value !== "string") throw new ValidationError(`${field.label} must be a URL.`);
      try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");
      } catch {
        throw new ValidationError(`${field.label} must be a valid http(s) URL.`);
      }
      return value;
    }
    case "PHONE": {
      if (typeof value !== "string" || !/^[+0-9()\-\s]{5,30}$/.test(value)) {
        throw new ValidationError(`${field.label} must be a valid phone number.`);
      }
      return value;
    }
    case "NUMBER":
    case "PERCENTAGE": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${field.label} must be a number.`);
      if (field.field_type === "PERCENTAGE" && (value < 0 || value > 100)) {
        throw new ValidationError(`${field.label} must be between 0 and 100.`);
      }
      if (v.min !== undefined && value < v.min) throw new ValidationError(`${field.label} is below the minimum.`);
      if (v.max !== undefined && value > v.max) throw new ValidationError(`${field.label} is above the maximum.`);
      return value;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw new ValidationError(`${field.label} must be true or false.`);
      return value;
    }
    case "DATE": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${field.label} must be a valid date.`);
      const date = new Date(value);
      const today = new Date(new Date().toDateString());
      if (v.allowFutureDate === false && date > today) throw new ValidationError(`${field.label} cannot be in the future.`);
      if (v.allowPastDate === false && date < today) throw new ValidationError(`${field.label} cannot be in the past.`);
      return value;
    }
    case "DROPDOWN": {
      const options = v.options || [];
      if (typeof value !== "string" || !options.includes(value)) throw new ValidationError(`${field.label} has an invalid value.`);
      return value;
    }
    case "MULTI_SELECT": {
      const options = v.options || [];
      if (!Array.isArray(value) || !value.every((item) => options.includes(item))) {
        throw new ValidationError(`${field.label} has an invalid value.`);
      }
      return value;
    }
    default:
      throw new ValidationError(`Unsupported field type for ${field.label}.`);
  }
}
