# Implementation Plan: Process Deduction Endpoint

- **Endpoint:** `POST /api/vendors/deductions`
- **Request body:** `{ "storeId": "1", "deductionId": "1" }`
- **Scope:** SELL_OUT expense events for NET_RECEIPTS deductions only

## Summary

The endpoint rebuilds all the expense events for one deduction. It works in two steps:

1. Delete every expense event that belongs to the deduction.
2. If the deduction is active, create one new expense event for each product sale in the deduction's date range.

The cost of each event is the sale's shipped revenue multiplied by the deduction value. Both steps run inside one database transaction, so either both succeed or neither does.

---

## Reading Guide

The task brief asks the plan to cover four topics. This is where each one is answered:

| The brief asks for | Answered in |
|---|---|
| Database reads: queries, indexes, joins and filtering | Section 3, Reading From the Database |
| Database writes: upsert strategy, batch sizes and transaction boundaries | Section 4, Writing to the Database |
| Performance with 100,000 or more product sales | Section 5, Performance |
| Future considerations | Section 8, Future Considerations |

Beyond the brief: the plan has also been implemented and tested. Section 7 lists the code changes and section 9 lists the tests. Section 6 covers known limitations, and section 10 describes the challenges I faced setting up the environment.

---

## How to Run

You need Docker (or Podman), Node.js 24 (see `.nvmrc`) and npm.

**1. Start and seed the database** (in the `database` folder):

```bash
cp .env.example .env
npm install
npm run db:setup          # with Podman: npm run db:setup:podman
```

**2. Start the API** (in the `aggregator-job` folder):

```bash
cp .env.example .env
npm install
npm run dev
```

The API runs at `http://localhost:3000`.

**3. Call the endpoint.** Seeded deduction 1 belongs to store 1:

```bash
curl -X POST http://localhost:3000/api/vendors/deductions \
  -H "Content-Type: application/json" \
  -d '{"storeId": "1", "deductionId": "1"}'
```

Calling it a second time returns the same number of events removed and created, which shows the endpoint is idempotent.

**4. Run the tests** (in the `aggregator-job` folder, with the database running):

```bash
npm test
```

The 19 integration tests call the endpoint against the real seeded database. Each test creates its own deductions and deletes them afterwards, so the seed data is left unchanged.

---

## 1. Key Decisions

**Decision 1: Delete the old events, then insert new ones.**
The delete only removes rows with this deduction's `deduction_id`. Calling the endpoint again always gives the same result, which makes it idempotent (Rule 4). The same two steps also handle:
- a changed deduction value
- a shorter date range (old rows outside the new range are removed)
- a deactivated deduction (rows are removed and nothing is inserted, as Rule 3 requires)

An update-or-insert ("upsert") approach can't remove rows that fall outside a shorter date range, so it was not chosen.

**Decision 2: Do the calculation inside the database.**
A single `INSERT ... SELECT` statement reads the sales, calculates the cost and writes the events. No sale rows are loaded into Node, so memory use stays the same whether there are 1,000 rows or 1,000,000.

**Decision 3: Use one transaction for the delete and the insert.**
If anything fails, both steps are undone. The previous events stay in place, so the client can safely retry.

**Decision 4: Use the deduction value exactly as it is stored.**
The database stores 5% as `0.05`, so the formula is `cost = shipped_revenue * deduction_value`. There is no division by 100.

**Decision 5: Make each deduction's events unique through `source_system_id`.**
The primary key of the expense events table is `store_id`, `source_system_id`, `expense_date`, `expense_type` and `expense_subtype`. It does not include `deduction_id`. If `source_system_id` were simply copied from the product, two deductions of the same type with overlapping dates would produce identical keys for the same product and day, and the second deduction would fail.

For example, a 5% `REFERRAL_FEE` for Jan 1 to Jan 31 and a 2% `REFERRAL_FEE` for Jan 15 to Jan 31 would clash on every day from Jan 15 to Jan 31.

The schema notes that `source_system_id` is an internal identifier that can be customised, as long as the primary key stays unique. So each event's `source_system_id` is the product's id with the deduction id appended, for example `MERCH001_SKU-1-001_DED_53`. Every deduction then has its own keys, overlapping deductions of the same type are processed independently, and no schema change is needed.

**Decision 6: Use plain SQL queries, not Sequelize models.**
The work is done by two SQL statements. Models would add extra files without adding any behaviour.

### Assumptions

- **Date ranges cover whole days, in UTC.** The deduction's start and end dates include a time of day. For example, a deduction might start at "Jan 1, 14:00". Rule 5 talks about dates, so the range is widened to cover the whole start day and the whole end day. A sale on Jan 1 at 08:00 is included.
- **Costs are rounded to 2 decimal places**, because the `cost` column only stores 2 decimals.
- **One expense event is created for each product sale row.** Scenario 1 says 500 sales should produce 500 events.
- **The success message is spelled "successfully".** The requirements contain a typo ("succesfully").

---

## 2. Request Flow

1. **Check the request body.** `storeId` and `deductionId` must both be present and contain digits only. Both database columns are numbers, so a value like `"abc"` must be rejected here. If the check fails, return **400 INVALID_REQUEST**.
   Ids may also be sent as JSON numbers, but only whole numbers small enough for JavaScript to hold exactly. A larger number would be silently rounded to a different id. A body that isn't valid JSON gets 400, and a body over the size limit gets 413, both with the `INVALID_REQUEST` error code.
2. **Start a transaction.**
3. **Look up the store.** If it doesn't exist, return **404 NOT_FOUND** with the message "Store not found".
4. **Look up and lock the deduction** for that store, using `SELECT ... FOR UPDATE`. If it doesn't exist, or it belongs to a different store, return **404 NOT_FOUND** with the message "Deduction not found". The lock means that if two requests for the same deduction arrive at the same time, the second one waits until the first has finished. It also stops anyone editing the deduction while it is being processed. The lock is released automatically when the transaction ends.
5. **Check the deduction basis.** If it is not `NET_RECEIPTS`, return **400 INVALID_REQUEST** with the message "Unsupported deduction basis".
6. **Delete** the deduction's existing expense events. Remember how many rows were removed.
7. **If the deduction is active, insert** the new expense events. Remember how many rows were created. If it is inactive, skip this step; the created count is 0.
8. **Commit the transaction** and return **200**.
9. **If anything goes wrong**, undo the transaction (roll back) and return **500 PROCESSING_FAILED**.

A waiting request only reads the deduction once the first request has finished, so it always works from the latest saved version. If steps 3 to 5 fail, nothing has been written yet, so undoing the transaction has no effect on the data.

A row lock is used instead of a database-wide "advisory lock". An advisory lock on the number N would also block any other system that happens to lock the number N for its own purposes.

### Responses

Success:

```json
{
  "status": "success",
  "message": "Deductions processed successfully",
  "expenseEventsRemoved": 0,
  "expenseEventsCreated": 1800
}
```

Error (the `error` value is `INVALID_REQUEST`, `NOT_FOUND` or `PROCESSING_FAILED`):

```json
{
  "status": "error",
  "error": "NOT_FOUND",
  "message": "Deduction not found"
}
```

---

## 3. Reading From the Database

### Find the store

```sql
SELECT store_id
FROM generic.store
WHERE store_id = :storeId;
```

This is fast because `store_id` has a unique index.

### Find the deduction

```sql
SELECT deduction_id, deduction_type, deduction_basis, deduction_value,
       vendor_code, effective_date_from, effective_date_to, is_active
FROM vendor.deductions
WHERE deduction_id = :deductionId
  AND store_id = :storeId
FOR UPDATE;
```

This is fast because `deduction_id` is the primary key. `FOR UPDATE` locks this one row until the transaction ends (see section 2, step 4).

### Find the product sales

The sales are not read separately. They are read by the insert statement in section 4, Writing to the Database. Three things keep that read fast:

- **Only the needed time ranges are scanned.** The `product_sales` table is a TimescaleDB "hypertable", which stores its rows in chunks by `report_date`. The date range is passed into the query as fixed values, worked out in Node from the deduction. TimescaleDB can then skip every chunk outside the range.
- **Only this store's rows are read.** The `store_id` filter uses the existing `idx_product_sales_store_id` index.
- **The product lookup is fast.** Each sale is joined to its product by `product_id`, which has a unique index.

---

## 4. Writing to the Database

### Step 1: Delete the old events

```sql
DELETE FROM vendor.expense_events
WHERE store_id = :storeId
  AND deduction_id = :deductionId;
```

This uses the `storeId_deductionId` index added in migration V1.3.

The delete is deliberately **not** limited by date. The deduction's dates may have changed since the last run, and rows outside the new range must also be removed.

Rows that belong to other deductions are never touched. Neither are the seeded "chargebacks" rows, which have no `deduction_id`.

### Step 2: Insert the new events

```sql
INSERT INTO vendor.expense_events (
  store_id, source_system_id, product_sku, expense_date, vendor_code,
  expense_type, expense_subtype, cost, expense_status, deduction_id,
  created_at, updated_at
)
SELECT
  ps.store_id,
  p.source_system_id || '_DED_' || :deductionId,
  p.product_sku,
  ps.report_date,
  :vendorCode,
  'SELL_OUT',
  :deductionType,
  ROUND(ps.shipped_revenue * :deductionValue, 2),
  'CONFIRMED',
  :deductionId,
  NOW(),
  NOW()
FROM vendor.product_sales ps
JOIN generic.product p ON p.product_id = ps.product_id
WHERE ps.store_id = :storeId
  AND ps.report_date >= :rangeStart
  AND ps.report_date <  :rangeEnd;
```

`rangeStart` is the start of the first day. `rangeEnd` is the start of the day after the last day.

### What goes in each column

| Column | Value | Taken from |
|---|---|---|
| store_id | The store's id | The sale |
| source_system_id | The product's id plus the deduction id, for example `MERCH001_SKU-1-001_DED_53` (see Decision 5) | The product and the deduction |
| product_sku | The product's SKU | The product |
| expense_date | The sale's `report_date` | The sale |
| vendor_code | The deduction's vendor code | The deduction |
| expense_type | Always `SELL_OUT` | Rule 2 |
| expense_subtype | The deduction's type, for example `REFERRAL_FEE` | The deduction |
| cost | Shipped revenue multiplied by the deduction value, rounded to 2 decimals | Calculated |
| expense_status | Always `CONFIRMED`, the same as the seeded rows | Fixed value |
| deduction_id | The deduction's id, so the delete can find these rows later | The deduction |
| created_at, updated_at | The current time | The clock |

### Upserts, batch sizes and transactions

- **No upsert.** Deleting and then inserting is simpler and also handles shorter date ranges and deactivated deductions.
- **No batches.** Each step is a single statement. The database writes all the rows itself, and Node never holds them.
- **One transaction.** It starts before the lookups (step 2 of the request flow) and ends at the commit (step 8). Sequelize's managed transaction, `sequelize.transaction(async (t) => { ... })`, commits automatically when the code succeeds. It rolls back automatically when anything throws an error, including a lost database connection.
- **Counts without returning rows.** The removed and created counts come from the row count the database reports for each statement. The rows themselves are never sent back to Node.

---

## 5. Performance

| Concern | How it is handled |
|---|---|
| Memory with 100,000 or more rows | Rows never enter Node. The service sends two statements and gets two numbers back. Memory use does not grow with the number of rows. |
| Load on the database | The database reads only the time chunks in range, uses indexes for the product lookups, and writes the rows in one pass. 100,000 rows takes a few seconds for one statement. |
| Network traffic | The same five or so short statements per request, however many rows there are. |
| Connection pool (maximum 10) | Each request uses one connection while its transaction is open. |
| Two calls for the same deduction at once | The lock makes the second call wait. It then rebuilds the same result. |
| Calls for different deductions at once | They don't block each other. Each one only deletes and inserts its own rows. |
| Table locking | The delete only locks this deduction's rows. The insert only adds new rows. The table as a whole is never locked. |

For scale: the seed data has 1,800 sale rows for store 1 (10 products over 180 days). 100,000 rows would be roughly 550 products over 180 days.

---

## 6. Known Limitations

### Limitation 1: Editing a deduction replaces its history

The endpoint always uses the deduction as it is saved right now.

Suppose a rate changes partway through a period, for example 5% until Jan 14 and 8% from Jan 15. It must be recorded as **two separate deductions**:
- 5% from Jan 1 to Jan 14
- 8% from Jan 15 to Jan 31

If someone instead edits the original deduction to "8% from Jan 15 to Jan 31", the costs for Jan 1 to Jan 14 are deleted.

### Limitation 2: Deduction values only have 2 decimal places

The `deduction_value` column stores only 2 decimal places. A rate of 2.5% (`0.025`) can't be stored and gets rounded to `0.03`.

---

## 7. Code Changes in aggregator-job

| File | What changes |
|---|---|
| `src/validators/vendors.validators.ts` | Both ids must contain digits only. If not, the error message is "Invalid storeId" or "Invalid deductionId". |
| `src/middleware/validateRequest.ts` | Validation errors use the response format from the requirements: `status`, `error` and `message`. |
| `src/middleware/errorHandler.ts` | **Fixes an existing bug.** Express only treats a function as an error handler if it has four parameters (`err, req, res, next`). This one has three, so it currently never runs. The fix adds the missing parameter. A small `AppError` class carries the status code, error code and message. Any unexpected error becomes **500 PROCESSING_FAILED**. |
| `src/services/deductions.service.ts` | **New file.** Contains `processDeduction(storeId, deductionId)`, which returns the removed and created counts. It holds the transaction, lock, lookups, checks, delete, insert and logging. |
| `src/routes/vendors.routes.ts` | Replaces the TODO. The handler calls the service and returns the success response. Errors are passed to the error handler by the `express-async-errors` package, which is already installed. |
| `package.json` | Adds the `test` script (`jest --coverage`). The README mentions `npm run test`, but the script is missing. |
| `tests/setup.ts` | **New file.** The Jest configuration already expects it. It closes the database connection after the tests finish. |
| `tests/deductions.test.ts` | **New file.** The tests listed in section 9, Testing. |
| `tests/tsconfig.json` | **New file.** Gives editors the project's TypeScript settings for the test files, which the main `tsconfig.json` excludes from the build. |

### Logging

Acceptance criterion 7 asks for every processing step to be logged. The service uses the existing `logger` to record:
- the start of processing, with the store and deduction ids
- the loaded deduction: its type, basis, whether it is active, and its date range
- how many events were removed
- how many events were created, or that the deduction is inactive and the insert was skipped
- that the transaction was committed
- any error message, before the transaction is rolled back

### Date handling

The range start and end are calculated with the `moment-timezone` package, which is already installed:
- range start: `moment.utc(effectiveDateFrom).startOf("day")`
- range end: `moment.utc(effectiveDateTo).startOf("day").add(1, "day")`

---

## 8. Future Considerations

1. **Add an index on `store_id` and `report_date` together** for the product sales table. It would make the date range search faster once stores have many products.

2. **Re-process deductions when sales data changes.** Sales rows are updated after they are first recorded; in the seed, updates arrive up to 48 hours later. Expense events go out of date until the endpoint is called again. A background job could re-run the affected deductions whenever sales change.

3. **Protect deduction history.** Prevent editing the value or dates of a deduction that has already been processed. Require a new deduction instead (see Limitation 1).

4. **Store deduction values with more precision.** Changing the column type to `DECIMAL(7,4)` would allow rates like 2.5% (see Limitation 2).

5. **Process very large requests in the background.** If requests ever take too long, the endpoint could return **202 Accepted** with a job id and run the same transaction in a background worker. A time limit on each statement (`statement_timeout`) would also stop a slow query from holding a connection forever.

6. **Support other deduction types.** `FIXED_AMOUNT` deductions and SELL_IN events (based on purchase orders) could use the same delete-then-insert approach with a different insert statement.

---

## 9. Testing

The tests send real HTTP requests (using `supertest`) to the API, which runs against the real seeded database. Run `npm run db:setup` in the `database` folder first.

Each test creates its own deductions for store 1. Afterwards it deletes those deductions and their expense events, so the seed data is left unchanged.

| Number | What is tested | Expected result |
|---|---|---|
| 1 | `deductionId` is `"abc"` | 400 INVALID_REQUEST |
| 2 | `storeId` is missing | 400 INVALID_REQUEST |
| 3 | The store doesn't exist | 404, "Store not found" |
| 4 | The deduction doesn't exist, or belongs to another store | 404, "Deduction not found" |
| 5 | The deduction is `FIXED_AMOUNT` | 400 INVALID_REQUEST |
| 6 | An active 10% deduction | The created count equals the number of store 1 sales in the date range. A sample row has the correct cost, `SELL_OUT` as its type and the correct `deduction_id`. |
| 7 | The same request sent twice | The second response removes and creates the same number of rows. The total number of rows doesn't change. |
| 8 | The deduction is deactivated, then processed (Scenario 2) | All of its rows are removed and none are created. |
| 9 | The date range is shortened, then processed | Rows outside the new range are removed. |
| 10 | Two overlapping deductions of the same type | Both succeed, and each keeps its own full set of events. |
| 11 | After any request | All the seeded "chargebacks" rows are still there. |
| 12 | A request body larger than the size limit | 413 INVALID_REQUEST |
| 13 | A JSON-number id too large to hold exactly | 400 INVALID_REQUEST |
| 14 | Two identical requests at the same time | Both return 200, and exactly one set of events remains. |
| 15 | A deduction whose dates contain no sales | 200, with 0 events created |

---

## 10. Challenges Faced

### Setting up the database without prior Docker experience

The database runs in containers, which the challenge sets up with Docker Compose. I had never used Docker before, so the first part of the challenge was learning what containers are and how Docker Compose starts them.

### Docker Desktop would not run, so I switched to Podman

Docker Desktop would not run on my machine. I switched to **Podman**, another container tool that can run the same `docker-compose.yml` files. That meant learning a second tool, and the leftovers from my earlier Docker installation caused many errors while I set Podman up.

### Changes needed to run the database with Podman

To get `npm run db:setup` working with Podman, I made three changes in the `database` folder:

1. **Commands in `package.json`.** The scripts call `docker-compose`. I added Podman versions next to them, with `:podman` at the end of the name: `db:setup:podman`, `db:teardown:podman`, `db:reset:podman`, `db:logs:podman` and `db:migrate:podman`. The original Docker scripts are unchanged.

2. **Full image names in `docker-compose.yml`.** Docker assumes images come from Docker Hub, so `timescale/timescaledb` is enough. Podman doesn't assume a registry, so I wrote the full names: `docker.io/timescale/timescaledb:latest-pg16` and `docker.io/flyway/flyway:latest`.

3. **Process limit in `docker-compose.yml`.** Starting the database failed with this error:

   ```
   Error response from daemon: crun: controller pids is not available under
   /sys/fs/cgroup/.../libpod-06a3...e52.scope/container/cgroup.controllers: OCI runtime error
   Error: executing C:\Users\User\AppData\Local\Microsoft\WindowsApps\docker-compose.exe up -d postgres: exit status 1
   ```

   By default, Podman limits every container to 2048 processes. Enforcing that limit needs a Linux feature called the "pids controller". On Windows, Podman runs containers inside a small Linux virtual machine, and that machine does not make this feature available to containers, so the container could not start. I added `pids_limit: -1` ("no limit") to both the database and Flyway containers. Podman then no longer needs the feature, and the containers start normally.

   I also changed the Podman machine's own settings, so that every container on it starts without process limits. First I checked whether a settings file already existed:

   ```powershell
   podman machine ssh "cat /etc/containers/containers.conf.d/99-no-cgroups.conf"
   ```

   It printed "No such file", so I logged in to the Podman machine and created the file:

   ```bash
   podman machine ssh
   sudo mkdir -p /etc/containers/containers.conf.d
   sudo tee /etc/containers/containers.conf.d/99-no-cgroups.conf <<'EOF'
   [containers]
   pids_limit = 0
   cgroups = "disabled"
   EOF
   exit
   ```

   - `pids_limit = 0` removes the process limit for all containers, the same as `pids_limit: -1` does for each container in `docker-compose.yml`.
   - `cgroups = "disabled"` stops Podman from using Linux resource controls (cgroups) for containers at all. The pids controller is one of these controls, so Podman no longer asks for the feature that was missing.

   This trades away resource limits (on memory, processor and processes) for every container on this Podman machine. That is acceptable for a local development database, but not for a shared or production machine.

   The second line of the error comes from how `podman compose` works. It does not start containers itself. It passes the work to a compose tool, and it picked up `docker-compose.exe`, left over from my earlier Docker installation. That tool sent the request to Podman, Podman failed with the first error, and the tool reported "exit status 1". It looked like a second problem, but it was the same one.

### Keeping the submission working for reviewers

Reviewers will most likely use Docker, so the default scripts still use Docker and `npm run db:setup` works for them as before. With Podman, run `npm run db:setup:podman` instead. The two `docker-compose.yml` changes also work with Docker, so they are safe to keep.

### What I learned

- How containers, images and volumes fit together, and how `docker-compose.yml` describes them
- How Flyway applies database migrations in version order when the containers start
- How to diagnose setup errors, and that Docker and Podman behave differently in small but important ways, such as image names and process limits
