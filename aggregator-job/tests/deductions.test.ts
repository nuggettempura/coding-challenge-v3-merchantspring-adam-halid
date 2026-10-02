import moment from "moment-timezone";
import { QueryTypes } from "sequelize";
import request from "supertest";

import app from "../src/app";
import { sequelize } from "../src/config/database";

const ENDPOINT = "/api/vendors/deductions";
const STORE_ID = "1";
const TEST_TYPE = "TEST_FEE";

// Deduction range, set in beforeAll from the seeded sales. It starts at 23:59 and
// ends at 00:01, so the whole-day rule is exercised at both ends.
let RANGE_FROM: string;
let RANGE_TO: string;

const createdDeductionIds: string[] = [];

interface DeductionInput {
  from: string;
  to: string;
  value?: string;
  basis?: "NET_RECEIPTS" | "FIXED_AMOUNT";
  active?: boolean;
}

const createDeduction = async (input: DeductionInput): Promise<string> => {
  const [row] = await sequelize.query<{ deduction_id: string }>(
    `INSERT INTO vendor.deductions (
       store_id, deduction_type, deduction_basis, deduction_value, currency,
       vendor_code, effective_date_from, effective_date_to, is_active, created_at, updated_at
     ) VALUES (
       :storeId, :type, :basis, :value, 'USD',
       'TEST_VENDOR', :from, :to, :active, NOW(), NOW()
     ) RETURNING deduction_id`,
    {
      replacements: {
        storeId: STORE_ID,
        type: TEST_TYPE,
        basis: input.basis ?? "NET_RECEIPTS",
        value: input.value ?? "0.10",
        from: input.from,
        to: input.to,
        active: input.active ?? true,
      },
      type: QueryTypes.SELECT,
    },
  );
  createdDeductionIds.push(row.deduction_id);
  return row.deduction_id;
};

const callEndpoint = (deductionId: string, storeId: string = STORE_ID) =>
  request(app).post(ENDPOINT).send({ storeId, deductionId });

const countEvents = async (deductionId: string): Promise<number> => {
  const [row] = await sequelize.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM vendor.expense_events WHERE deduction_id = :deductionId",
    { replacements: { deductionId }, type: QueryTypes.SELECT },
  );
  return row.n;
};

// Counts store 1 sales whose UTC calendar day falls between the two dates' UTC days.
// Written differently from the service on purpose, so the test checks the rule.
const expectedSalesCount = async (
  from: string,
  to: string,
): Promise<number> => {
  const [row] = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM vendor.product_sales
     WHERE store_id = :storeId
       AND (report_date AT TIME ZONE 'UTC')::date
           BETWEEN (CAST(:from AS timestamptz) AT TIME ZONE 'UTC')::date
               AND (CAST(:to AS timestamptz) AT TIME ZONE 'UTC')::date`,
    { replacements: { storeId: STORE_ID, from, to }, type: QueryTypes.SELECT },
  );
  return row.n;
};

beforeAll(async () => {
  const [row] = await sequelize.query<{ first: Date }>(
    "SELECT MIN(report_date) AS first FROM vendor.product_sales WHERE store_id = :storeId",
    { replacements: { storeId: STORE_ID }, type: QueryTypes.SELECT },
  );
  const firstDay = moment.utc(row.first).startOf("day");
  RANGE_FROM = firstDay
    .clone()
    .add(10, "days")
    .hour(23)
    .minute(59)
    .toISOString();
  RANGE_TO = firstDay.clone().add(39, "days").minute(1).toISOString();
});

afterEach(async () => {
  if (createdDeductionIds.length === 0) return;
  await sequelize.query(
    "DELETE FROM vendor.expense_events WHERE deduction_id IN (:ids)",
    { replacements: { ids: createdDeductionIds } },
  );
  await sequelize.query(
    "DELETE FROM vendor.deductions WHERE deduction_id IN (:ids)",
    { replacements: { ids: createdDeductionIds } },
  );
  createdDeductionIds.length = 0;
});

describe("POST /api/vendors/deductions: request validation", () => {
  it("rejects a non-numeric deductionId", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ storeId: "1", deductionId: "abc" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: "error",
      error: "INVALID_REQUEST",
      message: "Invalid deductionId",
    });
  });

  it("rejects a missing storeId", async () => {
    const res = await request(app).post(ENDPOINT).send({ deductionId: "1" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: "error",
      error: "INVALID_REQUEST",
      message: "Invalid storeId",
    });
  });

  it("rejects an id too large for BIGINT", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ storeId: "1", deductionId: "1234567890123456789" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("rejects a malformed JSON body", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send('{"storeId": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: "error",
      error: "INVALID_REQUEST",
      message: "Request body must be valid JSON",
    });
  });

  it("rejects a body larger than the JSON size limit as a client error", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ storeId: "1", deductionId: "1", padding: "x".repeat(200_000) });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("rejects a JSON-number id too large to be exact", async () => {
    // 2^53 + 1 cannot be represented exactly and would silently become 2^53.
    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send('{"storeId": "1", "deductionId": 9007199254740993}');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid deductionId");
  });
});

describe("POST /api/vendors/deductions: lookups", () => {
  it("returns 404 for an unknown store", async () => {
    const res = await callEndpoint("1", "999999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "error",
      error: "NOT_FOUND",
      message: "Store not found",
    });
  });

  it("returns 404 for an unknown deduction", async () => {
    const res = await callEndpoint("999999999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "error",
      error: "NOT_FOUND",
      message: "Deduction not found",
    });
  });

  it("returns 404 when the deduction belongs to another store", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });

    const res = await callEndpoint(id, "2");

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Deduction not found");
  });

  it("returns 400 for a FIXED_AMOUNT deduction", async () => {
    const id = await createDeduction({
      from: RANGE_FROM,
      to: RANGE_TO,
      basis: "FIXED_AMOUNT",
    });

    const res = await callEndpoint(id);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: "error",
      error: "INVALID_REQUEST",
      message: "Unsupported deduction basis: FIXED_AMOUNT",
    });
    expect(await countEvents(id)).toBe(0);
  });
});

describe("POST /api/vendors/deductions: processing", () => {
  it("creates one event per sale in range with the correct values", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    const expected = await expectedSalesCount(RANGE_FROM, RANGE_TO);
    expect(expected).toBeGreaterThan(0);

    const res = await callEndpoint(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      message: "Deductions processed successfully",
      expenseEventsRemoved: 0,
      expenseEventsCreated: expected,
    });
    expect(await countEvents(id)).toBe(expected);

    // Every event must match its sale: cost, labels and product.
    const [check] = await sequelize.query<{ matched: number; wrong: number }>(
      `SELECT COUNT(*)::int AS matched,
              COUNT(*) FILTER (WHERE
                e.cost <> ROUND(ps.shipped_revenue * 0.10, 2)
                OR e.expense_type <> 'SELL_OUT'
                OR e.expense_subtype <> :type
                OR e.expense_status <> 'CONFIRMED'
                OR e.product_sku <> p.product_sku
                OR e.vendor_code <> 'TEST_VENDOR'
                OR e.source_system_id <> p.source_system_id || '_DED_' || :id
              )::int AS wrong
       FROM vendor.expense_events e
       JOIN generic.product p
         ON p.product_sku = e.product_sku AND p.store_id = e.store_id
       JOIN vendor.product_sales ps
         ON ps.product_id = p.product_id AND ps.report_date = e.expense_date
       WHERE e.deduction_id = :id`,
      { replacements: { id, type: TEST_TYPE }, type: QueryTypes.SELECT },
    );
    expect(check).toEqual({ matched: expected, wrong: 0 });
  });

  it("accepts ids sent as JSON numbers", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ storeId: Number(STORE_ID), deductionId: Number(id) });

    expect(res.status).toBe(200);
  });

  it("gives the same result when called twice (idempotent)", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    const expected = await expectedSalesCount(RANGE_FROM, RANGE_TO);

    await callEndpoint(id);
    const second = await callEndpoint(id);

    expect(second.status).toBe(200);
    expect(second.body.expenseEventsRemoved).toBe(expected);
    expect(second.body.expenseEventsCreated).toBe(expected);
    expect(await countEvents(id)).toBe(expected);
  });

  it("removes all events when the deduction becomes inactive (Scenario 2)", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    const expected = await expectedSalesCount(RANGE_FROM, RANGE_TO);
    await callEndpoint(id);

    await sequelize.query(
      "UPDATE vendor.deductions SET is_active = FALSE WHERE deduction_id = :id",
      { replacements: { id } },
    );
    const res = await callEndpoint(id);

    expect(res.status).toBe(200);
    expect(res.body.expenseEventsRemoved).toBe(expected);
    expect(res.body.expenseEventsCreated).toBe(0);
    expect(await countEvents(id)).toBe(0);
  });
});

describe("POST /api/vendors/deductions: edge cases", () => {
  it("removes events outside a shortened date range", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    await callEndpoint(id);

    const newTo = moment.utc(RANGE_FROM).add(4, "days").toISOString();
    await sequelize.query(
      "UPDATE vendor.deductions SET effective_date_to = :newTo WHERE deduction_id = :id",
      { replacements: { id, newTo } },
    );
    const res = await callEndpoint(id);

    const expected = await expectedSalesCount(RANGE_FROM, newTo);
    expect(res.status).toBe(200);
    expect(res.body.expenseEventsCreated).toBe(expected);
    expect(await countEvents(id)).toBe(expected);
  });

  it("creates nothing when the range contains no sales", async () => {
    const id = await createDeduction({
      from: "2000-01-01T00:00:00Z",
      to: "2000-01-31T00:00:00Z",
    });

    const res = await callEndpoint(id);

    expect(res.status).toBe(200);
    expect(res.body.expenseEventsCreated).toBe(0);
  });

  it("processes overlapping deductions of the same type independently", async () => {
    const first = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    const second = await createDeduction({
      from: RANGE_FROM,
      to: RANGE_TO,
      value: "0.02",
    });
    const expected = await expectedSalesCount(RANGE_FROM, RANGE_TO);
    await callEndpoint(first);

    const res = await callEndpoint(second);

    expect(res.status).toBe(200);
    expect(res.body.expenseEventsCreated).toBe(expected);
    expect(await countEvents(first)).toBe(expected);
    expect(await countEvents(second)).toBe(expected);
  });

  it("handles two identical requests sent at the same time", async () => {
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });
    const expected = await expectedSalesCount(RANGE_FROM, RANGE_TO);

    const [a, b] = await Promise.all([callEndpoint(id), callEndpoint(id)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await countEvents(id)).toBe(expected);
  });

  it("never touches expense events that have no deduction", async () => {
    const countUnrelated = async () => {
      const [row] = await sequelize.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM vendor.expense_events WHERE deduction_id IS NULL",
        { type: QueryTypes.SELECT },
      );
      return row.n;
    };
    const before = await countUnrelated();
    const id = await createDeduction({ from: RANGE_FROM, to: RANGE_TO });

    await callEndpoint(id);
    await callEndpoint(id);

    expect(await countUnrelated()).toBe(before);
  });
});
