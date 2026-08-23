import multer from "multer";
import { AppError } from "../shared/errors/app-error.js";
import { logServerError } from "../shared/logging/safe-logger.js";

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
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: error.code === "LIMIT_FILE_SIZE" ? "Photo exceeds the size limit." : "Invalid file upload.",
      },
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
