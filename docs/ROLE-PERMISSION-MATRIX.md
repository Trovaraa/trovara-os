# Trovara OS Role & Permission Matrix

This matrix describes the current effective access in Trovara OS. “Admin” is the user-facing name for the internal `owner` role.

| Area | Admin | Supervisor | Field worker | Sales |
|---|---|---|---|---|
| Farm setup, users and security | Full control | No administrative changes | No access | No access |
| Today dashboard | Farm-wide view and exceptions | Farm-wide view and exceptions | Own tasks and attendance | Sales and order day-close |
| Tasks | Create, assign, approve and reopen | Create, assign and approve | Start and submit own tasks | No access |
| Attendance | View roster and correct records | View roster and correct records | Clock in/out, optionally add a daily summary, and view own record | No access |
| Crops, livestock, zones and templates | Manage | Manage | No management access | No access |
| Advisory and field reports | View, log and resolve | View, log and resolve | View advice and submit observations, incidents and photo evidence | No access |
| Inventory | Manage SKUs, product links, stock, movements, counts, tolerances, reconciliation and shrink/leakage alerts | Manage SKUs, product links, stock, movements, counts, tolerances, reconciliation and shrink/leakage alerts | May submit task-linked count records; cannot change stock | Read-only API access; cannot change stock or submit counts |
| Assets | Manage register and verify logs | Manage register and verify logs | View and submit asset logs | No screen access |
| Product catalogue | Add, edit and deactivate | Add and edit | No access | Add and edit |
| Orders and customer support | Full order management, support queue and customer insights | Manage orders and support queue | No access | Manage orders, conversations and support tickets |
| Finance | View and manage | No access | No access | View and manage |
| Traceability | Full control, exports and audit documents | Create and verify lots | View and report harvest lots | Create lots, labels and fulfilment records |
| Reports, events and audit | Full access | Operational events and manager summaries | No access | Sales and finance views only |
| Messaging and integrations | Configure and operate | Operational messaging | Worker commands and alerts | Customer and order messaging |
| Personal settings and language | Own profile plus farm settings | Own profile | Own profile | Own profile |

## Rules

- Permissions must be enforced by the API; hiding a menu item is not sufficient.
- All records are scoped to the user’s farm.
- Worker submissions that affect trusted records should require Admin or Supervisor verification.
- Destructive actions and security, user, audit and farm-configuration changes remain Admin-only.
- Changes to stock, orders, products, attendance and traceability must retain the user, time and record ID in the audit trail.
- Sales access never grants inventory write authority. Inventory item edits, movements, opening counts, count verification and reconciliation/shrink actions are enforced as Admin/Supervisor operations at the API. Order dispatch still decrements linked finished-goods stock as a system side-effect of fulfilment.
