# Mark invoices as already paid

This is an explicit historical-settlement confirmation, not a money transfer or a new dated payment.

## Individual invoice

In Finance → Expenses, open **Payments**. Choose **Mark as already paid**, review the remaining balance, check the confirmation and choose **Confirm fully paid**. No payment date, bank reference or due date is required for this action.

## Multiple invoices

Select invoice checkboxes (desktop and mobile), or select eligible invoices on the current page. Choose **Mark as already paid**, review each invoice and the totals by currency, then confirm. Selection is limited to the current page and clears when changing page, filters or refreshing. Invoices are not automatically selected just because they are old.

Only approved invoices with an outstanding balance are eligible. For a partially paid invoice, only the remaining balance is settled. The invoice stays in the register as **Paid**, with zero outstanding balance; it is not deleted or archived. Readers cannot confirm settlements.

## Audit and safety

- The append-only ledger distinguishes `historical_settlement` from a regular `payment`. It records the confirming user, server confirmation timestamp, amount/currency and retry ID. Actual payment date/reference remain null, rather than being invented.
- The history labels this as a confirmation, not a payment made on the confirmation date. Existing payment entries and approval/due dates are retained. Normal new-payment recording still requires its original date/reference/due-date checks.
- The server validates approval, farm access and the exact reviewed amount/currency/balance for every invoice before writing any of them. A stale or ineligible selection rejects the whole batch. Row locks and retry keys prevent double settlement and competing payments from exceeding the balance.
- This action is not reversible in the current UI, like existing recorded payments. The review explicitly warns about this. No refund/reversal or direct settlement-field editing is introduced.

## Rollout

Apply migration `20260925120000_0087_historical_settlement` before deploying the API and frontend. The migration does not settle any invoice automatically. Preserve the deployed Talent, finance, cost-centre and editor changes; never reset the dirty production checkout. Back up before deployment. Once historical entries exist, do not revert the database to non-null payment dates/references or to the earlier triggers. Do not bulk-settle real invoices during deployment/testing; the owner must select and confirm the correct invoices.
