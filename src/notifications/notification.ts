import { sendMail, type MailMessage, type MailOptions, type MailReceipt, type MailTransport } from '../mail/mail';

export interface Notification { toMail(recipient: string): MailMessage | Promise<MailMessage> }
export async function notifyMail(transport: MailTransport, notification: Notification, recipient: string, options?: MailOptions): Promise<MailReceipt> {
  options?.signal?.throwIfAborted();
  const message = await notification.toMail(recipient);
  options?.signal?.throwIfAborted();
  return sendMail(transport, message, options);
}
