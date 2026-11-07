/** Keys may be strings, symbols, or typed tokens created by the application. */
export type ServiceKey<T = unknown> = string | symbol | (abstract new (...args: never[]) => T);
export type ServiceLifetime = "singleton" | "scoped" | "transient";
export type ServiceFactory<T> = (scope: ServiceScope) => T;
type Registration = { lifetime: ServiceLifetime; factory: ServiceFactory<unknown> };
type Disposable = { dispose?: () => unknown; [Symbol.asyncDispose]?: () => unknown; [Symbol.dispose]?: () => unknown };

async function disposeAll(values: unknown[]): Promise<void> {
  const errors: unknown[] = [];
  for (const value of values.reverse()) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) continue;
    const resource = value as Disposable;
    try {
      if (typeof resource[Symbol.asyncDispose] === "function") await resource[Symbol.asyncDispose]?.();
      else if (typeof resource[Symbol.dispose] === "function") await resource[Symbol.dispose]?.();
      else if (typeof resource.dispose === "function") await resource.dispose();
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Service disposal failed.");
}

export class ServiceContainer {
  private readonly registrations = new Map<ServiceKey, Registration>();
  private readonly singletons = new Map<ServiceKey, unknown>();
  private readonly owned: unknown[] = [];
  private closed = false;
  private readonly owners = new WeakMap<object, object>();
  /** @internal */ claim(value: unknown, owner: object, owned: unknown[]): void {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
    const existing = this.owners.get(value);
    if (existing && existing !== owner && existing !== this) throw new Error("Conflicting service ownership across lifetimes or scopes.");
    if (!existing) { this.owners.set(value, owner); owned.push(value); }
  }
  register<T>(key: ServiceKey<T>, lifetime: ServiceLifetime, factory: ServiceFactory<T>): this {
    if (this.closed) throw new Error("Service container is disposed.");
    if (this.registrations.has(key)) throw new Error(`Service already registered: ${String(key)}`);
    if (!(lifetime === "singleton" || lifetime === "scoped" || lifetime === "transient") || typeof factory !== "function") throw new Error("Invalid service registration.");
    if (factory.constructor?.name === "AsyncFunction") throw new Error("Asynchronous service factories are not supported.");
    this.registrations.set(key, { lifetime, factory });
    return this;
  }
  createScope(): ServiceScope {
    if (this.closed) throw new Error("Service container is disposed.");
    return new ServiceScope(this);
  }
  /** @internal */ registration(key: ServiceKey): Registration {
    if (this.closed) throw new Error("Service container is disposed.");
    const registration = this.registrations.get(key);
    if (!registration) throw new Error(`Missing service: ${String(key)}`);
    return registration;
  }
  /** @internal */ singleton(key: ServiceKey, create: () => unknown): unknown {
    if (!this.singletons.has(key)) { const value = create(); this.claim(value, this, this.owned); this.singletons.set(key, value); }
    return this.singletons.get(key);
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await disposeAll(this.owned.splice(0));
  }
}

export class ServiceScope {
  private readonly scoped = new Map<ServiceKey, unknown>();
  private readonly owned: unknown[] = [];
  private readonly resolving: ServiceKey[] = [];
  private readonly pending: Promise<void>[] = [];
  private closed = false;
  constructor(private readonly container: ServiceContainer) {}
  resolve<T = unknown>(key: ServiceKey<T>): T {
    if (this.closed) throw new Error("Service scope is disposed.");
    const registration = this.container.registration(key);
    if (registration.lifetime !== "singleton" && this.resolving.some(parent => this.container.registration(parent).lifetime === "singleton")) {
      throw new Error("A singleton cannot depend on a shorter-lived service.");
    }
    if (this.resolving.includes(key)) throw new Error(`Cyclic service dependency: ${[...this.resolving, key].map(String).join(" -> ")}`);
    const create = () => {
      this.resolving.push(key);
      try {
        const value = registration.factory(this);
        if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
          // The factory has already run. Observe its result and clean up any eventual resource.
          const pending = Promise.resolve(value).then(async resource => {
            const owned: unknown[] = [];
            this.container.claim(resource, this, owned);
            await disposeAll(owned);
          });
          void pending.catch(() => {});
          this.pending.push(pending);
          throw new Error("Asynchronous service factories are not supported.");
        }
        return value;
      } finally { this.resolving.pop(); }
    };
    if (registration.lifetime === "singleton") return this.container.singleton(key, create) as T;
    if (registration.lifetime === "scoped" && this.scoped.has(key)) return this.scoped.get(key) as T;
    const value = create();
    this.container.claim(value, this, this.owned);
    if (registration.lifetime === "scoped") this.scoped.set(key, value);
    return value as T;
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const pending of this.pending) { try { await pending; } catch (error) { errors.push(error); } }
    try { await disposeAll(this.owned.splice(0)); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Service disposal failed.");
  }
}
