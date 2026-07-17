# Trovara Privacy Notice

Status: **Draft for legal and operational review**  
Effective date: **Not yet published**  
Applies to: Trovara OS, Trovara Farm customer ordering channels, and public
traceability pages.

This notice explains how Trovara collects, uses, shares, stores, and protects
personal data. It is written for farm staff, customers, suppliers, and other
people who use Trovara services.

This draft is adapted to Trovara's actual processing activities. It uses the
structure of established Nigerian privacy notices, including Moniepoint's
privacy notice, but does not copy language intended for Moniepoint's recruitment
or regulated banking activities.

## 1. Who controls your data

Trovara Farm is the data controller for its farm operations, customer orders,
public traceability records, and direct communications.

If Trovara OS is later supplied to independent farms as software, each farm may
act as the controller for its own staff and customer data, while the Trovara OS
operator may act as a processor. Those roles must be documented in a data
processing agreement before a multi-farm SaaS launch.

Privacy contact: `dpo@trovara.farm` **(reserved placeholder; must be activated
and monitored before publication)**.

## 2. Personal data we collect

Depending on how you interact with Trovara, we may collect:

- **Identity and account data:** name, work email, role, farm assignment, and
  account status.
- **Employment and payroll-profile data (staff):** staff ID, job title,
  employment type/status and dates, monthly wage amount and Admin confirmation
  metadata, and next-of-kin name, phone, and relationship. Trovara does not
  currently process bank account numbers, tax identifiers, or pay-run
  settlements in this product.
- **Contact and order data:** customer name, phone number, delivery address,
  Telegram or WhatsApp identifier, order contents, amount, status, and history.
- **Farm-work data:** assigned tasks, completion and approval records, notes,
  inventory movements, harvest and livestock logs, and the staff member who
  recorded or verified an event.
- **Field evidence:** optional photos, voice notes, transcripts, and location
  data supplied while documenting farm work.
- **Communications:** questions and messages sent through Telegram, WhatsApp,
  the customer order bot, or the Trovara AI assistant.
- **Security and device data:** session identifier, user agent, security events,
  and a one-way hash of the connecting IP address. Trovara does not intentionally
  store the raw IP address in the application session record.
- **Consent and audit data:** accepted notice version, consent type and time,
  and records of important actions performed in the system.
- **Public traceability data:** verified harvest-lot information selected for
  publication. Internal notes and personal data must not be published on a
  public lot page.

Trovara does not currently collect payment-card details. Customer bot orders
use payment on delivery. A future payment provider must collect and tokenize
card or bank details on its own secure systems; Trovara should store only the
provider's references and payment status.

## 3. How we obtain personal data

We obtain data:

- directly from you when you register, sign in, place an order, submit a farm
  record, upload evidence, or contact Trovara;
- from a farm owner or supervisor who creates an account, task, order, or farm
  record involving you;
- from Telegram and Meta WhatsApp when you message a connected Trovara bot or
  business account;
- automatically when the application creates session, audit, consent, and
  security records; and
- from service providers when they return message-delivery, AI-processing, or
  future payment results.

## 4. Why we use personal data

Trovara uses personal data to:

- create and secure user accounts;
- manage farm work, staff assignments, inventory, livestock, crops, assets,
  harvests, sales, finance, and traceability;
- accept, fulfil, update, and support customer orders;
- recognise returning bot customers and display their previous Trovara orders;
- send operational alerts and respond through Telegram or WhatsApp;
- transcribe voice notes and generate requested AI summaries or assistance;
- maintain audit trails, investigate errors, prevent abuse, and protect the
  service;
- satisfy accounting, employment, regulatory, and legal obligations; and
- improve farm operations using aggregated or appropriately de-identified
  information.

Trovara must not sell personal data or use private farm or customer data to
train a general-purpose AI model unless a separate, explicit agreement permits
it.

## 5. Lawful bases

The appropriate lawful basis depends on the activity:

- **Contract or steps before a contract:** account administration, customer
  ordering, delivery, and services requested by the user.
- **Legitimate interests:** secure farm operations, task coordination, fraud
  prevention, service reliability, and relevant customer support, balanced
  against the person's rights.
- **Legal obligation:** accounting, employment, tax, regulatory, and lawful
  disclosure duties.
- **Consent:** optional AI processing, marketing, non-essential media or
  location collection, and other processing where consent is the appropriate
  basis.

Marketing consent must be separate from service access. Withdrawing consent
does not invalidate processing that was lawful before withdrawal, and it may
not stop processing supported by another lawful basis.

## 6. AI, voice, photos, and automated processing

When an AI-enabled feature is used, relevant prompts, farm context, text,
photos, voice notes, or transcripts may be sent to the configured AI provider.
Only data necessary for the requested task should be sent.

AI output may be incomplete or incorrect. Trovara requires human confirmation
before AI-generated suggestions create or change operational records. Trovara
does not currently make legal, employment, credit, or similarly significant
decisions solely through automated processing.

Users should not include unrelated personal or confidential information in
prompts, photos, or voice notes.

## 7. Telegram and WhatsApp

Messages sent through Telegram or WhatsApp are also processed under those
platforms' terms and privacy practices. Trovara may receive the sender's
platform identifier, profile name, phone number where supplied, message
contents, media, and delivery metadata.

Customer chat identifiers are used to maintain a conversation, link orders to
the correct customer, recognise returning customers, and show that customer
their Trovara order history. Staff access to customer history must be
role-controlled and limited to operational need.

Do not send passwords, payment-card details, government identity documents, or
unrelated sensitive information through a Trovara bot.

## 8. Sharing and service providers

Trovara may disclose data only as necessary to:

- authorised Trovara staff and contractors whose roles require access;
- the infrastructure provider hosting the application, database, logs, and
  encrypted backups;
- Meta Platforms for WhatsApp Business messaging;
- Telegram for bot messaging;
- the configured AI provider for requested AI, transcription, image, or
  text-to-speech processing;
- notification, email, payment, or support providers added in the future;
- professional advisers, auditors, insurers, or authorities where legally
  required; and
- a successor organisation during a merger, restructuring, or sale, subject to
  appropriate confidentiality and legal safeguards.

Trovara must maintain a current sub-processor register identifying the provider,
purpose, data categories, processing location, and contractual safeguards
before this notice is published. Service providers must not use Trovara data
for their independent purposes unless separately disclosed and lawfully based.

## 9. International transfers

Telegram, Meta, AI providers, and infrastructure providers may process data
outside Nigeria. Before enabling each production integration, Trovara must
document the destination, transfer mechanism, provider terms, security
controls, and any NDPA-required adequacy or contractual safeguards.

Cross-border transfer must not be described as prohibited if an enabled
integration necessarily performs it. The transfer must instead be disclosed,
assessed, minimised, and protected in accordance with applicable law.

## 10. Retention

Trovara keeps personal data only for as long as necessary for the stated
purpose, legal obligations, dispute handling, security, and agreed farm
operations.

Current or proposed retention rules include:

- active operational and account data: while the farm uses the service, followed
  by an agreed export and deletion period;
- expired application sessions: removed after `SESSION_RETENTION_DAYS` (default 7) via the scheduled retention job;
- task photo and voice evidence: controlled by `DATA_RETENTION_DAYS` and the
  scheduled retention job;
- Butler chat message text in operational logs: redacted (not deleted) after
  `DATA_RETENTION_DAYS`;
- customer contact phone numbers on inactive bot contacts: nulled after
  `CUSTOMER_CONTACT_RETENTION_DAYS` (defaults to `DATA_RETENTION_DAYS`);
- encrypted backups: rolling retention defined in the backup runbook;
- financial and audit records: retained for the legally required period; and
- customer bot and order history: a specific production retention period must
  be approved before publication.

Trovara must replace these descriptions with an approved retention schedule
containing exact periods before publishing this notice. Deletion from active
systems may not immediately remove data from encrypted backups; backup copies
should expire according to their defined cycle and remain inaccessible for
ordinary use.

## 11. Security

Trovara uses safeguards appropriate to the service, including:

- Argon2 password hashing and optional owner TOTP authentication;
- opaque session tokens stored as hashes and delivered using secure,
  HTTP-only cookies in production;
- role-based access control and farm-scoped database queries;
- CSRF protection, request validation, rate limiting, and secure headers;
- signed or secret-verified WhatsApp and Telegram webhooks;
- audit and security logging;
- HTTPS in production; and
- encrypted database backups where the encrypted backup procedure is enabled.

No system is completely secure. Suspected unauthorised access should be reported
to the privacy contact. Trovara must assess and notify the Nigeria Data
Protection Commission and affected people where the NDPA requires it.

## 12. Your rights

Subject to applicable law and lawful exceptions, a data subject may request:

- information about how their personal data is processed;
- access to personal data held by Trovara;
- correction of inaccurate or incomplete data;
- deletion where Trovara has no overriding lawful reason to retain it;

  Where legal retention, accounting, or operational traceability requires keeping
  a record, Trovara **pseudonymizes** personal identifiers (name, email, phone)
  rather than hard-deleting orders, audit entries, or anonymized operational
  history. Audit log rows are never removed by automated retention.

- restriction of or objection to certain processing;
- withdrawal of consent where processing relies on consent;
- portability of data in an applicable structured format;
- review of a significant decision based solely on automated processing; and
- a complaint to the Nigeria Data Protection Commission.

Requests should be sent to the published privacy contact and must be verified
before data is disclosed or changed. Trovara should acknowledge, track, and
answer requests within the period required by the NDPA. Some records may be
retained where law, security, fraud prevention, accounting, or legal claims
require it.

Unresolved complaints may be submitted to the
[Nigeria Data Protection Commission](https://ndpc.gov.ng/).

## 13. Children

Trovara's staff application is not intended for children. Customer ordering and
future membership or tokenization products must not knowingly collect a child's
data or enter a financial arrangement with a child without an approved lawful
process involving a parent or guardian.

## 14. Cookies and local application storage

Trovara uses essential cookies for authenticated sessions and CSRF protection.
The application may use local browser storage for necessary PWA and offline
task functionality. Essential storage supports security and requested service
features.

Non-essential analytics or advertising cookies must not be introduced without
a separate cookie notice and, where required, a consent preference mechanism.

## 15. Public ledgers and future tokenization

Trovara does not currently publish operational or personal data to a
blockchain. If provenance or asset tokenization is introduced:

- personal data, customer identifiers, phone numbers, locations tied to a
  person, and private farm notes must remain off-chain;
- only a minimal proof, token identifier, transaction hash, or cryptographic
  commitment should be public;
- the immutable nature of a public ledger must be explained before collection;
  and
- a data-protection impact assessment and legal/regulatory review must be
  completed before launch.

## 16. Changes to this notice

Trovara may update this notice when its products, providers, or legal
obligations change. Material changes should receive a new version and effective
date. Where required, users will be notified and asked to provide fresh consent.

The application's consent version must be updated when a revised notice changes
the processing users previously accepted.

## 17. Publication checklist

Do not publish this draft until:

- [ ] the legal entity/controller name and physical address are confirmed;
- [ ] the privacy/DPO mailbox is active and monitored;
- [ ] lawful bases are reviewed by Nigerian privacy counsel;
- [ ] exact retention periods are approved;
- [ ] the hosting location and production sub-processors are listed;
- [ ] cross-border transfer safeguards are documented;
- [ ] staff and customer data-rights procedures are tested;
- [ ] AI, WhatsApp, Telegram, backup, and security statements are verified
      against production configuration;
- [ ] a cookie/local-storage inventory is completed;
- [ ] a breach-response process and regulatory contacts are approved; and
- [ ] the consent version is bumped when the final notice is published.

## References

- [Nigeria Data Protection Commission](https://ndpc.gov.ng/)
- [Moniepoint Recruitment Privacy Notice](https://moniepoint.com/ng/recruitment-privacy-policy)
- Trovara internal controls: [`ndpa-compliance.md`](./ndpa-compliance.md),
  [`security.md`](./security.md), and [`backup-runbook.md`](./backup-runbook.md)
