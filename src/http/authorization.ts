import type { HttpContext, HttpMiddleware } from './router.ts';

export interface PolicyContext {
  ability: string;
  principal: unknown;
  resource: unknown;
  signal: AbortSignal;
}

export interface AuthorizationPolicy {
  can(context: PolicyContext): boolean | Promise<boolean>;
}

export class AuthorizationDeniedError extends Error {
  constructor() {
    super('Authorization denied');
    this.name = 'AuthorizationDeniedError';
  }
}

function validateAbility(ability: unknown): asserts ability is string {
  if (typeof ability !== 'string' || ability.length > 128 || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(ability)) throw new TypeError('Invalid ability');
}

function validatePolicy(policy: AuthorizationPolicy): void {
  if (policy == null || typeof policy.can !== 'function') throw new TypeError('Invalid policy');
}

export async function evaluatePolicy(policy: AuthorizationPolicy, context: PolicyContext): Promise<boolean> {
  validateAbility(context.ability);
  validatePolicy(policy);
  context.signal.throwIfAborted();
  const decision = await policy.can(context);
  context.signal.throwIfAborted();
  if (typeof decision !== 'boolean') throw new TypeError('Invalid policy decision');
  return decision;
}

export async function authorizePolicy(policy: AuthorizationPolicy, context: PolicyContext): Promise<void> {
  const allowed = await evaluatePolicy(policy, context);
  context.signal.throwIfAborted();
  if (!allowed) throw new AuthorizationDeniedError();
}

export function policyMiddleware(options: {
  policy: AuthorizationPolicy;
  ability: string;
  principal: (context: HttpContext) => unknown | Promise<unknown>;
  resource?: (context: HttpContext) => unknown | Promise<unknown>;
}): HttpMiddleware {
  if (!options || typeof options !== 'object') throw new TypeError('Invalid policy middleware');
  const { policy, ability, principal, resource } = options;
  validatePolicy(policy);
  validateAbility(ability);
  if (typeof principal !== 'function' || (resource !== undefined && typeof resource !== 'function')) throw new TypeError('Invalid policy resolver');
  return async (context, next) => {
    const signal = context.request.signal;
    signal.throwIfAborted();
    const resolvedPrincipal = await principal(context);
    signal.throwIfAborted();
    const resolvedResource = resource ? await resource(context) : undefined;
    signal.throwIfAborted();
    const allowed = await evaluatePolicy(policy, { ability, principal: resolvedPrincipal, resource: resolvedResource, signal });
    signal.throwIfAborted();
    if (!allowed) return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    return next();
  };
}
