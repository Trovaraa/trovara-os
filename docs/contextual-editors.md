# Contextual editors

## Finance

Open **Finance → Expenses → Edit** to edit an invoice without leaving the list.
The drawer always shows saved approval status, payment status, due date and
outstanding balance. Approval status and payment status are different fields;
payment status is calculated from recorded payments, not chosen manually.

- **Expense details** edits the invoice and its approval state.
- **Payments** reviews the due date, payment history and records payments already
  made. The list's **Payments** button opens this section directly.
- Save changed expense details before changing the due date or recording a
  payment. An unsaved approval choice does not authorize payment recording.
- Pending/rejected invoices explain that approval is required. Approved invoices
  also require a saved due date. Fully paid invoices do not offer another payment.
- Once a payment exists, amount, legal entity and approval are locked in the UI,
  matching the existing API protections.
- Closing restores the invoking control, page and workspace scroll position.
  Updating a filter-related field does not silently reset the filters. If the
  invoice no longer matches the filter, its open drawer remains available.

No new database migration, payment provider, money-transfer behavior, permission
or approval bypass is introduced. All writes still use the existing authenticated
API and payment ledger.

## Shared interaction

Finance, Operations Library, Brand Kits, Careers, Journal and Talent use
`EditorDrawer`. The drawer is right-aligned on wider screens and full-width on
small screens, with its own scroll area and a persistent Close button.

The underlying list stays mounted. Keyboard focus stays inside the drawer;
Escape follows the same unsaved-edit check as Close. Background clicks do not
discard a draft, and closing is blocked while a save/upload is in progress.
Existing modal-based screens are retained; the shared `AccessibleDialog` also
restores scroll positions without scrolling its opener into a different place.

## Verification

Automated tests cover the shared dialog, all six affected screens, no writes on
open/cancel, pending/read-only payment restrictions, approval followed by partial
and full payments, failed saves/history requests, unsaved edits, page-two return,
filtered-out invoices, and Talent's unsaved extracted-contact suggestions.

Local browser checks use synthetic API responses only. Desktop and 390px-wide
Finance drawers were checked, including page-two focus/scroll restoration, plus
Careers and Talent drawer layouts. No live invoice, payment, applicant or email
was modified during verification. Deployment is a separate step.
