/**
 * The app's public origin, for building absolute redirect URLs.
 *
 * Behind the ALB, `req.url` in a standalone route handler resolves to the
 * TASK's internal hostname (observed live 2026-08-31: sign-in succeeded,
 * then Location pointed at
 * https://ip-10-0-1-201.us-west-2.compute.internal:3000/dashboard —
 * unreachable from a browser). The ECS deploy plan's rule is "explicit —
 * do not trust origin derivation behind the ALB"; OIDC_REDIRECT_URI is
 * that explicit origin and is always set where it matters (the task env,
 * .env.local). The req.url fallback keeps bare local setups working.
 */
export function appOrigin(req: Request): string {
  const fromEnv = process.env.OIDC_REDIRECT_URI;
  if (fromEnv) return new URL(fromEnv).origin;
  return new URL(req.url).origin;
}
