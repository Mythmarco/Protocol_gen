import { createHash } from "node:crypto";

// Helpers para loggear sin filtrar PHI/PII al stdout de Vercel.
//
// Workflow SOTA encontró que /api/pdf, /api/transcribe y /api/chat
// loggeaban nombres completos de pacientes, primeros 80 chars de
// transcripts (que incluyen edad/condición), etc. Bajo LFPDPPP (México)
// y HIPAA-equivalente esto convierte los logs de Vercel en un PHI store
// accesible por el equipo de Vercel — data leak material.
//
// Patrón: en LUGAR de logear el valor, logueamos un HASH corto del valor.
// Marco puede correlacionar por hash si un caso explota (mismo paciente
// → mismo hash en todos los endpoints), pero el log no es PHI.

const SALT = process.env.LOG_HASH_SALT || "p4a-default-salt-please-set";

/**
 * Hash corto (8 chars) para un identificador. SHA-256 con salt para que
 * no se pueda hacer reverse desde un nombre conocido a su hash sin la
 * salt. 8 chars = 32 bits = colisión esperada cada ~65k entradas, OK
 * para correlación de logs (no para autenticación).
 */
export function hashId(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const s = String(value).trim().toLowerCase();
  if (s.length === 0) return "empty";
  return createHash("sha256").update(SALT).update(s).digest("hex").slice(0, 8);
}

/**
 * Redacta un email: "marco@stacklabs.life" → "m***@stacklabs.life".
 * Permite ver el dominio para diagnóstico sin exponer el local-part.
 */
export function redactEmail(email: string | null | undefined): string {
  if (!email) return "null";
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Trunca un texto largo a su longitud — para cuando QUIERES saber que
 * llegó algo pero no qué dice. "Reta info para Juan Pérez 45 años" (33
 * chars) → "len=33".
 */
export function describeText(s: string | null | undefined): string {
  if (s == null) return "null";
  return `len=${String(s).length}`;
}

/**
 * Patient hash para correlación entre /api/chat, /api/pdf, /api/history.
 * Marco busca en logs por patient=ab12cd34 y ve toda la pipeline de un
 * mismo paciente sin que el log contenga el nombre real.
 */
export function patientHash(name: unknown): string {
  return `patient=${hashId(name)}`;
}

/**
 * Session hash — para correlacionar requests del mismo doctor.
 */
export function sessionHash(sessionId: unknown): string {
  return `session=${hashId(sessionId)}`;
}
