import { NextFunction, Request, Response } from "express";
import { ValidatedRequest, ValidationType } from "../types";

import { z } from "zod";

export const validateRequest = <T extends z.ZodTypeAny>(
  schema: T,
  validationType: ValidationType = "body",
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataToValidate = req[validationType];
      const validatedData = schema.parse(dataToValidate) as z.infer<T>;

      // Attach validated data to request for type safety
      (req as ValidatedRequest<T>).validatedData = validatedData;

      return next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          status: "error",
          error: "INVALID_REQUEST",
          message: error.errors[0].message,
        });
      }

      next(error);
    }
  };
};
