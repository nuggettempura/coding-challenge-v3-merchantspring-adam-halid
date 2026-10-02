import { QueryTypes, Transaction } from "sequelize";

import { AppError } from "../middleware/errorHandler";
import { logger } from "../utils/logger";
import moment from "moment-timezone";
import { sequelize } from "../config/database";

interface DeductionRow {
  deduction_id: string;
  deduction_type: string;
  deduction_basis: "FIXED_AMOUNT" | "NET_RECEIPTS";
  deduction_value: string;
  vendor_code: string | null;
  effective_date_from: Date;
  effective_date_to: Date;
  is_active: boolean;
}

export interface ProcessDeductionResult {
  expenseEventsRemoved: number;
  expenseEventsCreated: number;
}

const loadDeduction = async (
  storeId: string,
  deductionId: string,
  transaction: Transaction,
): Promise<DeductionRow> => {
  const stores = await sequelize.query(
    "SELECT store_id FROM generic.store WHERE store_id = :storeId",
    { replacements: { storeId }, type: QueryTypes.SELECT, transaction },
  );
  if (stores.length === 0) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }

  // FOR UPDATE: requests for the same deduction run one at a time, and the deduction
  // cannot be edited mid-run. The row lock is released on commit or rollback.
  const [deduction] = await sequelize.query<DeductionRow>(
    `SELECT deduction_id, deduction_type, deduction_basis, deduction_value,
            vendor_code, effective_date_from, effective_date_to, is_active
     FROM vendor.deductions
     WHERE deduction_id = :deductionId AND store_id = :storeId
     FOR UPDATE`,
    {
      replacements: { storeId, deductionId },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  if (!deduction) {
    throw new AppError(404, "NOT_FOUND", "Deduction not found");
  }
  if (deduction.deduction_basis !== "NET_RECEIPTS") {
    throw new AppError(
      400,
      "INVALID_REQUEST",
      `Unsupported deduction basis: ${deduction.deduction_basis}`,
    );
  }
  return deduction;
};

const deleteEvents = (
  storeId: string,
  deductionId: string,
  transaction: Transaction,
): Promise<number> =>
  // Not filtered by date: rows outside a shortened range must go too.
  sequelize.query(
    `DELETE FROM vendor.expense_events
     WHERE store_id = :storeId AND deduction_id = :deductionId`,
    {
      replacements: { storeId, deductionId },
      type: QueryTypes.BULKDELETE,
      transaction,
    },
  );

const insertEvents = async (
  storeId: string,
  deduction: DeductionRow,
  transaction: Transaction,
): Promise<number> => {
  // Whole UTC days, inclusive. Passed as constants so TimescaleDB can skip
  // product_sales chunks outside the range.
  // source_system_id gets a per-deduction suffix (the schema allows a derived value as
  // long as the primary key stays unique), so deductions of the same type with
  // overlapping dates never produce the same expense_events key.
  const rangeStart = moment
    .utc(deduction.effective_date_from)
    .startOf("day")
    .toDate();
  const rangeEnd = moment
    .utc(deduction.effective_date_to)
    .startOf("day")
    .add(1, "day")
    .toDate();

  const [, created] = await sequelize.query(
    `INSERT INTO vendor.expense_events (
       store_id, source_system_id, product_sku, expense_date, vendor_code,
       expense_type, expense_subtype, cost, expense_status, deduction_id,
       created_at, updated_at
     )
     SELECT ps.store_id, p.source_system_id || '_DED_' || :deductionId, p.product_sku,
            ps.report_date, :vendorCode,
            'SELL_OUT', :deductionType, ROUND(ps.shipped_revenue * :deductionValue, 2),
            'CONFIRMED', :deductionId, NOW(), NOW()
     FROM vendor.product_sales ps
     JOIN generic.product p ON p.product_id = ps.product_id
     WHERE ps.store_id = :storeId
       AND ps.report_date >= :rangeStart
       AND ps.report_date < :rangeEnd`,
    {
      replacements: {
        storeId,
        deductionId: deduction.deduction_id,
        deductionType: deduction.deduction_type,
        deductionValue: deduction.deduction_value,
        vendorCode: deduction.vendor_code,
        rangeStart,
        rangeEnd,
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );
  return created;
};

export const processDeduction = async (
  storeId: string,
  deductionId: string,
): Promise<ProcessDeductionResult> => {
  logger.info("Processing deduction", { storeId, deductionId });

  try {
    const result = await sequelize.transaction(async (transaction) => {
      const deduction = await loadDeduction(storeId, deductionId, transaction);
      logger.info("Loaded deduction", {
        deductionId,
        type: deduction.deduction_type,
        basis: deduction.deduction_basis,
        isActive: deduction.is_active,
        from: deduction.effective_date_from,
        to: deduction.effective_date_to,
      });

      const removed = await deleteEvents(storeId, deductionId, transaction);
      logger.info("Removed existing expense events", { deductionId, removed });

      if (!deduction.is_active) {
        logger.info("Deduction is inactive, skipping insert", { deductionId });
        return { expenseEventsRemoved: removed, expenseEventsCreated: 0 };
      }

      const created = await insertEvents(storeId, deduction, transaction);
      logger.info("Created expense events", { deductionId, created });
      return { expenseEventsRemoved: removed, expenseEventsCreated: created };
    });

    logger.info("Committed deduction processing", { deductionId, ...result });
    return result;
  } catch (error) {
    logger.warn("Rolled back deduction processing", {
      deductionId,
      message: (error as Error).message,
    });
    throw error;
  }
};
