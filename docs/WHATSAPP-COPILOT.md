# Trovara Butler - WhatsApp Copilot (end-to-end test guide)

The Butler turns Trovara OS into a conversational farm assistant on WhatsApp, like
NeuraAgro's "Joaquín". Workers and the owner can:

- **Chat in any language** (English, Pidgin, Yoruba, French, Hausa, Igbo) - the Butler replies in the same language.
- **Ask about the farm** - "How many birds are alive?", "What needs restocking?", "How much have we sold?" - answered from live data.
- **Report a sick animal** - "3 broilers are weak with green droppings" → likely causes, treatments available in Nigeria, prevention.
- **Send a photo** of a sick plant or animal → AI vision diagnosis.
- **Type `brief`** → a short "what needs attention today" summary.

Urgent worker messages (death, disease, theft, fire, flood…) are auto-forwarded to the **owner's** WhatsApp.

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

**Urgent escalation test:** send `"3 chickens died this morning"` - the owner (a
user with role `owner` and a phone) should receive an alert message.

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
   - "my goats are coughing and have nasal discharge" → diagnosis (+ owner alert)
   - Send a photo of a plant/animal → vision diagnosis
8. **Owner alert:** from a *worker's* phone send "many birds died" → the *owner's*
   phone should get the escalation.

---

## How it behaves (reference)

| Inbound | Butler action |
| --- | --- |
| `hi` / `hello` / `help` / `menu` | Sends the help menu |
| `brief` / `today` | Short daily attention summary |
| Any other text | AI answer grounded in farm data + Africa farm knowledge, with 2-hour conversation memory |
| Photo (image) | Downloads the media, runs vision diagnosis, replies in the sender's language |
| Voice note (audio) | Transcribed (Yoruba/Pidgin/French/English auto-detected), echoed back, then answered/diagnosed |
| Urgent keywords from a worker | Above reply **plus** an alert to the owner |
| Unknown phone | Ignored (logged) |

Outbound owner alerts can also be triggered from the app/automation:

```
POST /api/whatsapp/notify-owner   (owner/supervisor)
{ "message": "Feed store is empty", "reason": "low_stock" }
```

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
