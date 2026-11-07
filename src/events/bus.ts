export type EventListener = (payload: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
export interface EventMetadata { readonly event: string; readonly listeners: number; readonly listenerNames: readonly string[] }
interface Registration { listener: EventListener; name: string }
export function validEventName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
export class EventBus {
  private readonly listeners = new Map<string, Registration[]>();
  on(event: string, listener: EventListener, options: { name?: string } = {}): () => void {
    if (!validEventName(event) || typeof listener !== 'function') throw new Error('Invalid event or listener');
    const name = options.name ?? (listener.name || '(anonymous)');
    if (typeof name !== 'string' || !name || name.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Invalid listener name');
    const entries = this.listeners.get(event) ?? [];
    if (!this.listeners.has(event)) this.listeners.set(event, entries);
    const registration: Registration = { listener, name };
    entries.push(registration);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = entries.indexOf(registration);
      if (index >= 0) entries.splice(index, 1);
      if (!entries.length && this.listeners.get(event) === entries) this.listeners.delete(event);
    };
  }
  async dispatch(event: string, payload: unknown, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (!validEventName(event)) throw new Error('Invalid event');
    const errors: unknown[] = [];
    for (const { listener } of [...(this.listeners.get(event) ?? [])]) {
      if (signal.aborted) break;
      try { await listener(payload, signal); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Event ${event} listener failures`);
  }
  describe(): EventMetadata[] { return [...this.listeners].map(([event, listeners]) => ({ event, listeners: listeners.length, listenerNames: listeners.map(listener => listener.name) })); }
}
