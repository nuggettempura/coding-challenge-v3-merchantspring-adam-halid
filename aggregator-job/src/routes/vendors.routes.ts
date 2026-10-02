import {
  DeductionsValidatedRequest,
  deductionsQuerySchema,
} from "../validators/vendors.validators";
import { Response, Router } from "express";

import { processDeduction } from "../services/deductions.service";
import { validateRequest } from "../middleware/validateRequest";

const router = Router();

router.post(
  "/deductions",
  validateRequest(deductionsQuerySchema, "body"),
  async (req: DeductionsValidatedRequest, res: Response) => {
    // Set by validateRequest middleware; safe to assert
    const { storeId, deductionId } = req.validatedData!;

    // Errors thrown here reach errorHandler through express-async-errors (loaded in app.ts).
    const result = await processDeduction(storeId, deductionId);

    res.status(200).json({
      status: "success",
      message: "Deductions processed successfully",
      ...result,
    });
  },
);

export default router;
