# Explicit local text-mail and notifications

This is a reviewed local-only Bun contract, not complete Laravel mail/notification or external-delivery compatibility.

Bundle's code-only delivery contract uses plain text, explicitly injected transports and a local private outbox. There is no HTML/template engine, SMTP implementation, external inbox delivery, credential configuration, automatic sending, attachment support or queue/retry integration. A local acceptance receipt means persistence in this project, not delivery to a recipient.

## Generate, then explicitly consume

```sh
bun run bundle make:mail Billing/InvoiceMail
bun run bundle make:notification Billing/InvoiceNotice
```

Names use PascalCase with optional slash-separated directories. Classes are emitted into `src/mail` and `src/notifications`, with computed aliased type imports. Mail examples use the reserved non-deliverable `recipient@example.invalid`. Generation/import/construction never sends anything. Customize the example content and explicitly compose a transport:

```ts
import { InvoiceMail } from "./src/mail/Billing/InvoiceMail.ts";
import { InvoiceNotice } from "./src/notifications/Billing/InvoiceNotice.ts";
import { sendMailable } from "./src/mail/mail.ts";
import { LocalOutboxMailTransport } from "./src/mail/outbox.ts";
import { notifyMail } from "./src/notifications/notification.ts";

// An explicit absolute project root supplied by the application host.
const transport = new LocalOutboxMailTransport(root);
const receipt = await sendMailable(transport, new InvoiceMail(), { signal });
await notifyMail(transport, new InvoiceNotice(), "recipient@example.invalid", { signal });
```

`Mailable.build()` returns a `MailMessage` directly or asynchronously. `Notification.toMail(recipient)` returns the same typed message; `notifyMail` explicitly adapts that mail channel. The recipient argument is application input, not authenticated identity. No notification table, database persistence, automatic channel selection, event hooks or other channels are implied.

`sendMail(transport, message, {signal?})` validates/copies before invoking the selected transport. `sendMailable` builds then uses that path. A missing transport refuses rather than succeeding as a disabled delivery. Transports and builders are trusted code, not a sandbox; their external side effects, uncooperative work and cancellation rollback cannot be guaranteed by these adapters.

## Bounded plain-data format

A message has only `to`, `subject`, `text`, optional `from` and optional `replyTo`:

- `to`:1–32 conservative ASCII mailbox strings, each at most320 UTF-8 bytes. One mailbox per string; display-name/header syntax, controls, CR/LF and NUL are refused. This intentionally narrow prototype grammar is not comprehensive RFC/international email validation.
- `subject`: nonempty, at most998 UTF-8 bytes, no C0/DEL controls or CR/LF.
- `text`: at most64KiB UTF-8 bytes; line breaks are preserved, NUL and unpaired surrogate strings refused. Text is not interpreted as markup.
- Whole serialized message: at most128KiB. Records must also fit128KiB, including metadata, so boundary messages can be refused by the local transport even if valid independently.
- Closed plain-data shape, dense arrays and lossless copied strings only. No custom prototypes, getters, symbols, unknown fields or truncation. Stored bodies/recipients remain unredacted.

`stub:publish` includes consumed `mail.ts.stub` and `notification.ts.stub`, requiring `{{name}}` and `{{runtimeImport}}`. Overrides are trusted executable TypeScript. Existing outputs, including symlinks, are never overwritten; `--force` does not enable replacement.

## Private local outbox

`LocalOutboxMailTransport(root)` explicitly selects version1 JSON persistence at `.bundle-mail/outbox/<id>.json`, separately from ORM databases, logs and queues. Root aliases canonicalize; paths never derive from recipients/subjects. Private owned0700 directories and0600 single-link regular records are required. Complete records are file-synced before exclusive create-only publication. Parent directory entries and the completed outbox publication are directory-synced before acceptance; unsupported/failed sync refuses acceptance. Crash durability is conditional on the OS/filesystem honoring successful fsync, not a tested power-loss guarantee. Failed/crashed sends may leave state for inspection; failed-send cleanup mutations are not separately directory-synced. Existing unsafe paths are preserved, never silently reset. Identity checks/cleanup are path-based, not atomic against hostile concurrent tree/entry replacement, which is outside the filesystem guarantee.

The entire `.bundle-mail` directory is gitignored because messages may contain secrets and personal data. Local permissions are not encryption. Keep application roots private and apply a separate retention/backup/access policy. Errors and default metadata must not echo body, subject or recipients.

```ts
// Up to100 filesystem-order entries, not a sorted or complete snapshot.
const metadata = await transport.list({ limit: 100 });
// Caller-controlled continuation/full traversal without accumulating all entries.
for await (const item of transport.iterate()) {
  inspectMetadata(item); // Stop with break when appropriate; closes the iterator.
}
// Explicit raw-content access; the caller is responsible for a safe output sink.
const record = await transport.read(receipt.id);
```

`list` accepts1..1000 (default100), stops when that many records are obtained and refuses if more than1000 directory entries must be examined before reaching that limit. Ordinary accumulated outboxes remain inspectable with small limits or `iterate()`. The iterator has bounded memory/per-record reads but no total-work cap; callers control traversal. Neither API promises stable order, snapshots or durable cursors under mutation. Matching private two-link temporary publications are omitted while incomplete (including stale crash remnants); unrelated hardlinks still refuse. A single-link record can become visible before its sender receives acceptance. No exactly-once/transactional-observer claim is made.

No implicit console/logger output, replay/clear command, retention daemon or SMTP sending is provided. A custom injected transport needs its own failure, credential, cancellation, header/idempotency and live-service verification contract. Local fixtures do not verify such services.

## Evidence gate

Focused runtime and filesystem tests plus actual separate-process generator/custom-stub/consumer tests must pass before this slice is credited. The final checkpoint will record independent review, any red-first regression repairs, full test/type/graph checks and remaining limitations. PostgreSQL/MariaDB and external mail services are not required or authorized by this local-only slice.
