import { NextFunction, Request, Response } from "express";

import { logger } from "../utils/logger";

export type ErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "PROCESSING_FAILED";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Express only treats a middleware as an error handler when it takes 4 arguments,
// so `_next` must stay even though it is unused.
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  logger.error("Error occurred:", {
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query,
  });

  if (err instanceof AppError) {
    res
      .status(err.statusCode)
      .json({ status: "error", error: err.code, message: err.message });
    return;
  }

  // express.json() errors (invalid JSON, body too large, bad charset) carry a 4xx status.
  const { status, type } = err as { status?: number; type?: string };
  if (status && status >= 400 && status < 500) {
    res.status(status).json({
      status: "error",
      error: "INVALID_REQUEST",
      message:
        type === "entity.parse.failed"
          ? "Request body must be valid JSON"
          : err.message,
    });
    return;
  }

  res.status(500).json({
    status: "error",
    error: "PROCESSING_FAILED",
    message: `Failed to process deduction: ${err.message}`,
  });
};
