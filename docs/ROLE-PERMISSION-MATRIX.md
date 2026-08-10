# Trovara OS Role & Permission Matrix

This matrix describes the current effective access in Trovara OS. “Admin” is the user-facing name for the internal `owner` role.

For HTTP route roles see [`API.md`](./API.md). Security controls (not a second matrix): [`security.md`](./security.md).

| Area | Admin | Supervisor | Field worker | Sales |
|---|---|---|---|---|
| Farm setup, users and security | Full control | No administrative changes | No access | No access |
| Today dashboard | Farm-wide view and exceptions | Farm-wide view and exceptions | Own tasks and attendance | Sales and order day-close |
| Tasks | Create, assign, approve and reopen | Create, assign and approve | Start and submit own tasks | No access |
| Attendance and hours | Clock in/out; view farm-wide hours and correct records | Clock in/out; view farm-wide hours and correct records | Clock in/out, optionally add a daily summary, and view own hours | Clock in/out and view own hours |
| Crops, livestock, zones and templates | Manage | Manage | No management access | No access |
| Advisory and field reports | View, log and resolve | View, log and resolve | View advice and submit observations, incidents and photo evidence | No access |
| Inventory | Manage SKUs, product links, stock, movements, counts, tolerances, reconciliation and shrink/leakage alerts | Same as Admin | **No Inventory screen.** Cannot change stock. May submit task-linked count sessions via API/Telegram handover when tasked; supervisor verifies before stock posts. No dedicated worker count UI in the PWA | **No inventory screen.** Cannot change stock or submit counts. Order dispatch may still decrement linked finished-goods stock as a system side-effect of fulfilment |
| Assets | Manage register and verify logs | Manage register and verify logs | View and submit asset logs | No screen access |
| Product catalogue | Add, edit and deactivate | Add and edit | No access | Add and edit |
| Orders, packing and delivery | Full order management, support queue and customer insights | Manage orders and support queue | No access | Manage orders, packing/dispatch/delivered updates, conversations and support tickets (pilot: sales owns delivery coordination; no separate driver role yet) |
| Finance | View and manage | No access | No access | View and manage |
| Traceability | Full control, exports and audit documents | Create and verify lots | View and report harvest lots | Create lots, labels and fulfilment records |
| Reports | Full access | No Reports screen | No access | No Reports screen |
| Public Journal | Create, edit, publish, unpublish and delete | No access | No access | No access |
| Events / audit trail | Full access | Full events/audit API (same endpoint as Admin; treat as trusted ops) | No access | No Events screen |
| AI Copilot | Full access | Full access | No access | No access |
| Messaging and integrations | Configure and operate | Operational messaging + WhatsApp send | Worker commands and alerts | Template copy / customer messaging context; **WhatsApp API send is Admin/Supervisor only** |
| Personal settings and language | Own profile plus farm settings | Own profile | Own profile | Own profile |

## Rules

- Permissions must be enforced by the API; hiding a menu item is not sufficient.
- All records are scoped to the user’s farm.
- Worker submissions that affect trusted records should require Admin or Supervisor verification.
- Destructive actions and security, user, audit and farm-configuration changes remain Admin-only.
- Changes to stock, orders, products, attendance and traceability must retain the user, time and record ID in the audit trail.
- Sales access never grants inventory write authority. Inventory item edits, movements, opening counts, count verification and reconciliation/shrink actions are enforced as Admin/Supervisor operations at the API.
