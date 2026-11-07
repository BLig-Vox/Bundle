export interface MailMessage { readonly to: readonly string[]; readonly subject: string; readonly text: string; readonly from?: string; readonly replyTo?: string }
export interface MailReceipt { readonly id: string; readonly accepted: true }
export interface MailOptions { readonly signal?: AbortSignal }
export interface MailTransport { send(message: MailMessage, options?: MailOptions): Promise<MailReceipt> }
export interface Mailable { build(): MailMessage | Promise<MailMessage> }

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.isWellFormed() && bytes(value) <= limit;
}
function mailbox(value: unknown): value is string {
  if (!validString(value, 320)) return false;
  // Deliberately excludes quoted local parts, address literals and internationalized names.
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value);
}
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid mail message.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) throw new Error('Invalid mail message.');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function validateMailMessage(value: unknown): MailMessage {
  const input = ownData(value, ['to', 'subject', 'text', 'from', 'replyTo']);
  const to = input.to;
  if (!Array.isArray(to) || Object.getPrototypeOf(to) !== Array.prototype || to.length < 1 || to.length > 32 || Reflect.ownKeys(to).length !== to.length + 1) throw new Error('Invalid mail message.');
  const recipients: string[] = [];
  for (let i = 0; i < to.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(to, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !mailbox(descriptor.value)) throw new Error('Invalid mail message.');
    recipients.push(descriptor.value);
  }
  if (!validString(input.subject, 998) || !input.subject || /[\x00-\x1f\x7f]/.test(input.subject) || !validString(input.text, 65536) || input.text.includes('\0') || ('from' in input && !mailbox(input.from)) || ('replyTo' in input && !mailbox(input.replyTo))) throw new Error('Invalid mail message.');
  const result: MailMessage = { to: Object.freeze(recipients), subject: input.subject, text: input.text, ...('from' in input ? { from: input.from as string } : {}), ...('replyTo' in input ? { replyTo: input.replyTo as string } : {}) };
  if (bytes(JSON.stringify(result)) > 131072) throw new Error('Invalid mail message.');
  return Object.freeze(result);
}
export async function sendMail(transport: MailTransport, message: MailMessage, options?: MailOptions): Promise<MailReceipt> {
  options?.signal?.throwIfAborted();
  const snapshot = validateMailMessage(message);
  if (!transport || typeof transport.send !== 'function') throw new Error('Mail transport is required.');
  options?.signal?.throwIfAborted();
  const result = await transport.send(snapshot, options);
  options?.signal?.throwIfAborted();
  return result;
}
export async function sendMailable(transport: MailTransport, mailable: Mailable, options?: MailOptions): Promise<MailReceipt> {
  options?.signal?.throwIfAborted();
  const message = await mailable.build();
  options?.signal?.throwIfAborted();
  return sendMail(transport, message, options);
}
