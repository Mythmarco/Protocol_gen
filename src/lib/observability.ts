// Observability shim. Hoy NO usamos Sentry instalado (evitamos el
// overhead del SDK y la configuración pre-time). Esta capa es la
// abstracción que el codebase consume — cuando configuremos Sentry,
// solo se cambia la implementación dentro de captureException/captureMessage
// SIN tocar los call-sites.
//
// El workflow SOTA flagged "cero observability" como must-fix. Esta es
// la pieza intermedia: ya tenemos los call-sites correctos en su lugar
// (request-id, tags, redacción de PII) y el día que se configure
// SENTRY_DSN solo se agrega el SDK aquí.

import { sessionHash, hashId } from "./safe-log";

// IMPORTANTE: NUNCA pongas PHI en los tags ni en el message — Sentry
// las indexa en una DB persistente. Solo IDs hash, rutas, status codes.
type Tags = Record<string, string | number | undefined>;

interface ObservabilityCtx {
  route: string;
  sessionId?: string;
  patientHash?: string;
  folio?: string;
  reqId?: string;
}

function tagsFromCtx(ctx: ObservabilityCtx, extra?: Tags): Tags {
  return {
    route: ctx.route,
    session: ctx.sessionId ? sessionHash(ctx.sessionId) : undefined,
    patient: ctx.patientHash,
    folio: ctx.folio,
    req: ctx.reqId,
    ...extra,
  };
}

function tagsToString(t: Tags): string {
  return Object.entries(t)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

// Genera un request-id corto para correlacionar logs + eventual Sentry.
// El doctor recibe el reqId en el mensaje de error UI ("Error #ab12cd34"),
// Marco lo busca en los logs para reconstruir el flow exacto.
export function newRequestId(): string {
  return hashId(`${Date.now()}-${Math.random()}`).slice(0, 8);
}

export function captureException(
  err: unknown,
  ctx: ObservabilityCtx,
  extra?: Tags
): void {
  const tags = tagsFromCtx(ctx, extra);
  const msg = err instanceof Error ? err.message : String(err);
  // TODO Sentry: Sentry.captureException(err, { tags });
  console.error(`[error] ${tagsToString(tags)} msg=${msg}`);
  if (err instanceof Error && err.stack && process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }
}

export function captureMessage(
  message: string,
  ctx: ObservabilityCtx,
  extra?: Tags
): void {
  const tags = tagsFromCtx(ctx, extra);
  // TODO Sentry: Sentry.captureMessage(message, { tags });
  console.log(`[event] ${tagsToString(tags)} ${message}`);
}
