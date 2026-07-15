# Trovara Butler on Telegram

Telegram is the fastest channel to test the Butler. Unlike WhatsApp Cloud API it
needs **no business verification, no app review, no Meta account, and no public URL**
(long-polling works straight from your laptop). It uses the exact same AI brain as the
WhatsApp butler and the web Copilot.

**Bot (already created):** [@TrovaraButlerBot](https://t.me/TrovaraButlerBot)

## What's required

| Need | Detail |
| --- | --- |
| Bot | Already live - open [t.me/TrovaraButlerBot](https://t.me/TrovaraButlerBot) |
| `TELEGRAM_BOT_TOKEN` in `.env` | Token from BotFather for **@TrovaraButlerBot** (not a new bot) |
| `OPENAI_API_KEY` | Powers answers + photo diagnosis |
| A Trovara user to link | One-time **link code** from Settings, or share your own phone contact |

That's it. No ngrok needed in the default **polling** mode.

> Do **not** create a second bot with BotFather for testing - reuse **@TrovaraButlerBot**.
> Only one process may poll this token at a time (stop local `npm run dev` when the server is running the butler).

---

## Step 1 - Configure Trovara

In `.env`:

```env
TELEGRAM_BOT_TOKEN=<token for @TrovaraButlerBot from BotFather>
TELEGRAM_MODE=polling
```

Restart the API (`npm run dev`). You should see in the log:

```
Telegram butler: long-polling started
```

Check status any time: `GET http://127.0.0.1:3000/api/telegram/status`.

## Step 2 - Link your account

1. Open Telegram → [@TrovaraButlerBot](https://t.me/TrovaraButlerBot) → **Start**.
2. Connect your Trovara account using **one** of these:
   - **Link code (recommended):** Web app → **Settings → Connect Telegram** → generate a code → send `/link ABC12XYZ` to the bot (expires in 15 minutes).
   - **Phone (mobile):** tap **📱 Share my phone number**. Only *your* Telegram contact card is accepted, and the number must match a Trovara user profile exactly.

You'll get a generic `Connected successfully` message (no account enumeration). Revoke the link anytime from Settings.

> `/link email` is **disabled** - that flow was removed for security.

## Step 3 - Test it

Send these to [@TrovaraButlerBot](https://t.me/TrovaraButlerBot):

| You send | Expect |
| --- | --- |
| `help` | The capability menu |
| `What's the revenue today?` | The correct figure from live data (owner only) |
| `What needs restocking?` | Low-stock items |
| `brief` | A short "attention today" summary |
| `My goats are coughing with nasal discharge` | Diagnosis: likely causes, treatment, prevention |
| A **photo** of a plant/leaf or animal | Vision diagnosis in your language |
| A **voice note** (Yoruba, Pidgin or English) | Transcribed, then answered - bot echoes "🗣️ …" then replies |

> Voice notes: the butler transcribes the audio (language auto-detected - Yoruba,
> Nigerian Pidgin and English all work), shows you what it heard, then answers or
> diagnoses from it. Set `LLM_TRANSCRIBE_MODEL` in `.env` to change the model.
>
> TTS replies: when enabled, Butler can also send voice replies. Default mode is
> `voice_replies` (send voice only after inbound voice notes). Telegram users can
> change per-user preference with `/voice off`, `/voice voice`, or `/voice always`.

**Owner alert test:** link a *worker* account on a second Telegram account (or just
change a user's role), then send "many birds died" - any **owner** who has linked
Telegram gets an alert.

---

## Roles & data

- The Butler answers using live farm records from Trovara and your role: only **owners** see
  revenue/expense/profit figures; supervisors get operational data; workers get
  operational + advisory help.
- Every message (in/out) is stored as a `farm_events` row (`telegram_message`).
- 2-hour conversation memory makes follow-up questions work.

## Production / webhook mode (later)

Polling is great for testing. For production you can switch to webhooks:

1. Set `TELEGRAM_MODE=webhook` and `TELEGRAM_WEBHOOK_SECRET` (required in production).
2. Expose the API over HTTPS (deploy, or `ngrok http 3000`).
3. As the owner, register the webhook:
   ```
   POST /api/telegram/set-webhook   { "url": "https://YOUR_HOST/api/telegram/webhook" }
   ```
   (or `POST /api/telegram/delete-webhook` to go back to polling).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No log line about polling | `TELEGRAM_BOT_TOKEN` empty or `TELEGRAM_MODE` ≠ `polling`; restart after editing `.env` |
| Bot never replies | Token wrong for **@TrovaraButlerBot**, or another process already polling the same bot (only one poller allowed) |
| Invalid or expired link code | Generate a fresh code in Settings (15 min TTL) |
| Share-contact does nothing | Number not on any user profile, or you shared someone else's contact - set your phone on Users, or use a link code |
| Answers say "not switched on" | `OPENAI_API_KEY` missing - check the web AI page shows **AI ready** |
| `409 Conflict` in logs | A webhook is set AND polling is running - call `delete-webhook`, or set `TELEGRAM_MODE=webhook`. Also stop a second local poller if the server is already running the bot. |

## Safety

Guidance is assistive - every diagnosis reminds the user to confirm serious cases with
a vet/agronomist. Get worker consent before messaging them (see `docs/ndpa-compliance.md`).

## Bot admin (only if needed)

The bot already exists. Use BotFather only to **rotate the token** (`/revoke` → `/token` for @TrovaraButlerBot) or change the display name - never create a duplicate bot for Trovara OS.
