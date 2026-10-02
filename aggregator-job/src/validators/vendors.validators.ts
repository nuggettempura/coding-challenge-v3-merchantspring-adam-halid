import { ValidatedRequest } from "../types";
import { z } from "zod";

// Ids are BIGINT columns: digits only, at most 18 so every value fits in a BIGINT.
// JSON numbers are accepted too and converted to strings.
const bigintId = (name: string) =>
  z
    // Unsafe integers (above 2^53) would be silently rounded to a different id.
    .union(
      [z.string(), z.number().refine(Number.isSafeInteger, `Invalid ${name}`)],
      {
        errorMap: () => ({ message: `Invalid ${name}` }),
      },
    )
    .transform(String)
    .pipe(z.string().regex(/^\d{1,18}$/, `Invalid ${name}`));

export const deductionsQuerySchema = z.object({
  storeId: bigintId("storeId"),
  deductionId: bigintId("deductionId"),
});

export type DeductionsQuery = z.infer<typeof deductionsQuerySchema>;

/** Request type for routes that use validateRequest(deductionsQuerySchema, ...) */
export type DeductionsValidatedRequest = ValidatedRequest<
  typeof deductionsQuerySchema
>;
