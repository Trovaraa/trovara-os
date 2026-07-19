# Trovara Butler - WhatsApp Copilot (end-to-end test guide)

The Butler turns Trovara OS into a conversational farm assistant on WhatsApp, like
NeuraAgro's "Joaquín". Workers and the owner can:

- **Chat in any language** (English, Pidgin, Yoruba, French, Hausa, Igbo) - the Butler replies in the same language.
- **Ask about the farm** - "How many birds are alive?", "What needs restocking?", "How much have we sold?" - answered from live data.
- **Report a sick animal** - "3 broilers are weak with green droppings" → likely causes, treatments available in Nigeria, prevention.
- **Send a photo** of a sick plant or animal → AI vision diagnosis.
- **Type `brief`** → a short "what needs attention today" summary.
- **Type `help`** → commands for **your role only** (field ≠ sales ≠ admin).
- **Admin/Supervisor drafts** (then reply `CONFIRM` or `CANCEL`):
  - Task / Census / Asset / Crop / Livestock batch (as before)
  - Stock: `Stock: Feed bags delta=-2 reason=used`
  - Opening: `Opening count: Feed bags=50`
  - `Ack low stock`
  - `Create zone: North Field` · `Create plot: Block 2 zone=North Field`
  - Pack: `pack LOT-…` then qty/plot/notes/photo · `Verify LOT-…` / `Reject LOT-…`
- **Field (+ supervisor) livestock logs:** `Feed: Broiler A` · `Vaccinate: …` · `Mortality: Broiler A heads=3`

Urgent worker messages (death, disease, theft, fire, flood…) raise a **worker alert** to supervisors and owners who opted into Worker alerts in Settings (Telegram / WhatsApp).

The same brain powers the web app at **AI Assistant** (`/ai`): Copilot chat, "Why is my animal sick?", and "Why is my crop not growing?" (photo).

---

## What you need (one-time)

| Requirement | Where |
| --- | --- |
| AI key | `OPENAI_API_KEY` in `.env` (vision needs `gpt-4o-mini` or `gpt-4o` - already the default) |
| Meta WhatsApp app + permanent token | See `docs/INTEGRATIONS.md → 1. Meta WhatsApp Cloud API` |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | `.env` |
| A public URL to your laptop | `ngrok http 3000` (or a deployed HTTPS domain) |
| Worker/owner rows with a `phone` that matches their WhatsApp number | Users page or seed data |

> The Butler matches an inbound WhatsApp number to a Trovara user by phone. **If the
> number isn't on any user, the message is ignored.** Set phones first.

---

## Part A - Test the AI brain WITHOUT WhatsApp (fastest)

You can fully test the intelligence in the web app before wiring Meta.

1. Put your `OPENAI_API_KEY` in `.env`, restart the API (`npm run dev`).
2. Open the app → **AI Assistant**. The badge should read **AI ready**.
3. **Copilot:** ask "What is the total revenue so far?" → expect a real figure from your data.
4. **Why is my animal sick?** enter `broiler` + "weak, not eating, greenish watery droppings since yesterday" → expect likely causes (e.g. Newcastle/coccidiosis), treatments, prevention.
5. **Why is my crop not growing?** upload a leaf photo → expect a vision diagnosis.

If these work, the AI is good - WhatsApp just adds the channel.

---

## Part B - Simulate an inbound WhatsApp message locally (no Meta needed)

The webhook accepts the same JSON shape Meta sends, so you can curl it.

Two prerequisites:

1. A user must have a `phone` that matches the `from` number, e.g. `2348012345678`.
2. The POST webhook is guarded by `isWhatsAppConfigured()`, so set **placeholder**
   `WHATSAPP_*` values in `.env` (any non-empty strings) and restart. The AI will run
   and the conversation will be recorded; the outbound send simply fails silently
   because the token is fake. (With real Meta creds, the reply is actually delivered.)

```env
WHATSAPP_ACCESS_TOKEN=placeholder
WHATSAPP_PHONE_NUMBER_ID=placeholder
WHATSAPP_VERIFY_TOKEN=placeholder
```

**Text message:**

```bash
curl -X POST http://127.0.0.1:3000/api/whatsapp/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "2348012345678",
            "id": "wamid.TEST1",
            "timestamp": "1700000000",
            "type": "text",
            "text": { "body": "How many birds are alive?" }
          }]
        }
      }]
    }]
  }'
```

Expected: `{"ok":true,"handled":1}`. The Butler runs the AI and records the
conversation in `farm_events` (entityType `whatsapp_message`). With **real** Meta
creds the reply is delivered to the number; with placeholders the send is skipped.

**Urgent escalation test:** send `"3 chickens died this morning"` from a *field worker*
phone — supervisors (and owners subscribed to Worker alerts) should receive the alert.

---

## Part C - Go live with Meta (real phones)

1. **Fill `.env`** with the three `WHATSAPP_*` values + your `OPENAI_API_KEY`; restart the API.
2. **Expose the API:** `ngrok http 3000` → copy the `https://….ngrok-free.app` URL.
3. **Configure the webhook** in Meta Developer Console → WhatsApp → Configuration:
   - Callback URL: `https://YOUR_NGROK_HOST/api/whatsapp/webhook`
   - Verify token: same string as `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save** (Meta calls the GET endpoint and expects the challenge back).
4. **Subscribe to the `messages` field** (Webhook fields → toggle `messages`). This is required for inbound text AND image events.
5. **Add tester numbers:** in WhatsApp → API Setup, add the phone numbers you'll test with as **recipients** (required until your number is out of test mode / approved).
6. **Map those numbers to users:** open the app → Users, set each tester's `phone` to their full international number (e.g. `2348012345678`).
7. **Send a test from your phone** to the business number:
   - "hi" → help menu
   - "What needs restocking?" → data answer
   - "my goats are coughing and have nasal discharge" → diagnosis (+ worker alert to supervisors / subscribed owners)
   - Send a photo of a plant/animal → vision diagnosis
8. **Worker alert:** from a *field worker's* phone send "many birds died" →
   **supervisors** (and owners who opted into Worker alerts in Settings) get the
   escalation on WhatsApp/Telegram.

---

## How it behaves (reference)

| Inbound | Butler action |
| --- | --- |
| `hi` / `hello` / `help` / `menu` / `ops` | Field / ops command help (+ order help if sales/supervisor/owner) |
| `brief` / `today` | Short daily attention summary |
| `/clockin` · `/clockout` | Attendance (field workers) |
| `/tasks` · `/taskstart` · `/done` · `/done TSK-…` | List / start / submit tasks |
| `/approve` · `/reject` | Approve or reject awaiting tasks (supervisor / owner) |
| Photo captioned `done TSK-…` | Submit task with photo evidence |
| `/lots` · `/handover` | Packs-needed lot list / handover progress summary |
| `/printqr` · `/printqr LOT-…` | Box QR image + printable label link (sales / supervisor / owner) |
| `confirm` / `dispatch` / `delivered` / `cancel` + order ref | Order status update (owner / supervisor / sales) |
| Photo captioned `delivered TRV-ORD-…` | Mark delivered with optional photo |
| Voice note (audio) | Transcribed, then same ops/order parsers, else AI answer |
| Photo (image) | Vision diagnosis (unless caption is a `done` / `delivered` command) |
| Any other text | AI answer grounded in farm data + Africa farm knowledge |
| Urgent keywords from a worker | Above reply **plus** a worker alert (supervisors + subscribed owners) |
| Task submitted (`/done`) | Worker alert: task awaiting approval |
| `lang en\|yo\|pcm\|fr` | Set preferred reply language |
| Unknown phone | Ignored (logged) |

WhatsApp does not have Telegram-style inline buttons — pick lists are sent as numbered text; reply with the command + id (e.g. `/done TSK-ABCDEF`). Pack/enrich for harvest lots is still in Telegram or the Traceability app.

**Customer order alerts** fan out WhatsApp to supervisor + sales (and owners who opted in via Settings). **Worker alerts** (task done / urgent field reports) go to supervisors + opted-in owners. Customer status pushes on WhatsApp only work when Meta session/templates allow (24h window); Telegram is unrestricted.

**Manual / automation alerts** (still owner-targeted) can be triggered from the app:

```
POST /api/whatsapp/notify-owner   (owner/supervisor)
{ "message": "Feed store is empty", "reason": "low_stock" }
```

Prefer the subscription-based **customer** and **worker** alert streams for day-to-day ops.

## Next build plan (staff butler parity)

Same phased backlog as Telegram — see [next-steps-trovara-os.md](../../next-steps-trovara-os.md) §3
and [TELEGRAM-COPILOT.md](./TELEGRAM-COPILOT.md#next-build-plan-staff-butler-parity).

**Already on WhatsApp:** role-scoped `help`; create-task / census / asset-count / crop /
livestock / inventory / zone / plot / pack / verify / livestock-log drafts with
`CONFIRM` / `CANCEL`; voice notes run the same command path as text; orders + ops
gated by role.

**Staff butler parity P0–P5 is complete.** Remaining staff work is Meta go-live and
web-only setup (Users, Settings/2FA, etc.).

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Webhook "Verify and save" fails | `WHATSAPP_VERIFY_TOKEN` mismatch, or API not reachable via ngrok |
| Inbound returns `501` | `WHATSAPP_*` not set / API not restarted after editing `.env` |
| No reply received | Number not added as a Meta tester, or token expired (use a *permanent* system-user token) |
| "from unknown phone" in logs | The sender's number isn't on any user - set it on the Users page |
| Photo reply says "could not open" | Token lacks media permission, or media expired - resend |
| AI says it can't answer | `OPENAI_API_KEY` missing/empty - check **AI ready** badge in `/ai` |

---

## Safety & compliance

- The Butler is **assistive, not authoritative**. Every diagnosis ends with a line to
  confirm serious cases with a vet/extension officer and verify drug doses with an agrovet.
- All WhatsApp messages (in and out) are stored as `farm_events` for audit.
- Get worker **consent** before messaging their numbers (see `docs/ndpa-compliance.md`).
- Redact sensitive data before it leaves the farm; financial figures are only shared
  with the owner.
