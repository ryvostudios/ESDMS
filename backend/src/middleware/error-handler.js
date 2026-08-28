import multer from "multer";
import { AppError } from "../shared/errors/app-error.js";
import { logServerError } from "../shared/logging/safe-logger.js";

function firstValidationMessage(error) {
  if (error.code !== "VALIDATION_ERROR") return error.message;
  const formErrors = Array.isArray(error.details?.formErrors) ? error.details.formErrors : [];
  const fieldErrors = error.details?.fieldErrors && typeof error.details.fieldErrors === "object"
    ? Object.values(error.details.fieldErrors).flat()
    : [];
  const first = [...formErrors, ...fieldErrors].find((message) => typeof message === "string" && message.trim());
  return first || error.message;
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found.",
    },
  });
}

// Must be registered last, with 4 args, for Express to treat it as an
// error handler.
export function errorHandler(error, req, res, next) {
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      const requestId = logServerError(error, req);
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, requestId },
      });
    }

    return res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: firstValidationMessage(error),
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: {
        code: tooLarge ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
        message: tooLarge ? "Uploaded file exceeds the size limit." : "Invalid file upload.",
      },
    });
  }

  if (error?.type === "entity.parse.failed" && error instanceof SyntaxError) {
    return res.status(400).json({
      success: false,
      error: { code: "MALFORMED_JSON", message: "Request body contains malformed JSON." },
    });
  }

  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(413).json({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." },
    });
  }

  const requestId = logServerError(error, req);

  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
      requestId,
    },
  });
}
