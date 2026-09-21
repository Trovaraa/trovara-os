# Invoice payments and CAPEX

Finance tracks supplier invoices as expenses. Approval and settlement are separate:

- `unpaid`: no payment recorded (including zero-value invoices).
- `partially_paid`: recorded payments are below the invoice amount.
- `paid`: recorded payments equal the invoice amount.

Use **Expenses → Payments** to review/set the due date, record a payment already made,
and inspect its history. This feature does not initiate bank transfers. Payments use
the existing expense convention of whole currency units, not the asset register's
minor-unit acquisition costs. Amount, date and reference are required.

Only approved invoices with a reviewed due date can accept payments. New approvals
default to seven calendar days after approval (UTC), unless a due date was supplied.
Due dates remain editable by finance writers. Historical records are **not** assumed
paid and their approval dates are not fabricated: review their due dates and record
historical payments from evidence. Overdue means an approved outstanding invoice
whose due date is before today (UTC).

Payment requests require a UUID retry key. Database row locks and a request-key
advisory lock serialize concurrent requests; an identical retry returns the original
payment. A database trigger updates the balance/status in the same transaction.
Payment entries retain the recording user and timestamp and are append-only.
Paid invoices cannot change amount, currency, legal entity or approval, be deleted,
or have currency conversion/extraction applied. Refunds/reversals are not implemented
in this first version; do not use direct edits to rewrite payment history.

CAPEX is a farm-wide Finance tab with two automatically populated, searchable lists:
the existing asset register and expenses carrying the `capex` label. It ignores the
expense-list filters and says so in the UI. It does not infer that every asset is
capitalized, create duplicate assets from invoices, link the two lists, calculate
depreciation or sum them into a potentially double-counted valuation. Existing asset
management remains the source of truth. Inactive assets remain visible for tracking.

All endpoints require existing Finance read access; writes additionally require
`finance.write`. Every query is farm-scoped. No public/marketing/shop changes.

## Release

Apply migration `20260921120000_0085_expense_payments` **before** deploying the new API.
Back up the database first. This branch does not change production or send email.
The additive migration preserves old invoice fields and records. Rolling back the
application must retain the new ledger and triggers; never drop recorded payments.

## Verification

`npm run test:finance-integration -w api` requires `FINANCE_TEST_DATABASE_URL` pointing
to localhost and a disposable database whose name starts with `finance_test`.
Apply migrations to that database first. Tests use synthetic records and mock email
acknowledgments; they cover approval/due dates, partial/full settlement, overpayment,
concurrency, retry deduplication, record immutability, authorization and CAPEX scoping.

`FINANCE_TEST_DATABASE_URL=... node api/scripts/test-finance-upgrade.mjs` requires an
**empty** disposable database and tests the previous schema with an existing invoice
before upgrading. CI runs this historical-data test and the integration suite.
