import type { ProtocoloData } from "./protocol-types";

// Server-side enrichment of protocol metadata. Run after the AI returns its
// finalize_protocol JSON, BEFORE rendering the PDF. We do this server-side
// so dates and creator email are guaranteed correct — never trust the model
// to know today's date or who is logged in.

const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function todayLocal(): Date {
  return new Date();
}

// Format like "14/05/2026 (jueves)" — matches the original PDF style.
function formatDateWithWeekday(d: Date, idioma: "es" | "en"): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const weekday = (idioma === "en" ? WEEKDAYS_EN : WEEKDAYS_ES)[d.getDay()];
  return `${dd}/${mm}/${yyyy} (${weekday})`;
}

// Plain ISO date for the metadata.fecha field (used in filename/Drive folder).
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Try to parse the AI's date string (any of YYYY-MM-DD, DD/MM/YYYY,
// "14/05/2026 (jueves)", or natural language). Returns null if hopeless.
function tryParseDate(s: string | undefined | null): Date | null {
  if (!s || typeof s !== "string") return null;
  // Strip any "(weekday)" suffix
  const cleaned = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // ISO?
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }
  // DD/MM/YYYY?
  const ddmmMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmMatch) {
    return new Date(Number(ddmmMatch[3]), Number(ddmmMatch[2]) - 1, Number(ddmmMatch[1]));
  }
  // Fallback to Date constructor
  const parsed = new Date(cleaned);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function addMonths(d: Date, months: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function enrichProtocolMetadata(
  protocol: ProtocoloData,
  doctor: { name: string; email: string }
): ProtocoloData {
  const today = todayLocal();
  const idioma: "es" | "en" = protocol.metadata?.idioma === "en" ? "en" : "es";

  // ── creado_por: ALWAYS the signed-in doctor ──
  protocol.metadata.creado_por = doctor.email;
  protocol.metadata.idioma = idioma;
  if (!protocol.metadata.version) protocol.metadata.version = "1.0";

  // ── fecha (today's date, ISO format) ──
  protocol.metadata.fecha = isoDate(today);

  // ── fecha_inicio: AI's value if parseable, else today ──
  const inicioParsed = tryParseDate(protocol.metadata.fecha_inicio);
  const inicio = inicioParsed ?? today;
  protocol.metadata.fecha_inicio = formatDateWithWeekday(inicio, idioma);

  // ── fecha_revision: AI's value if parseable, else inicio + duracion_meses (default 1) ──
  const revisionParsed = tryParseDate(protocol.metadata.fecha_revision);
  const durMeses = Math.max(1, protocol.protocolo?.duracion_meses ?? 1);
  const revision = revisionParsed ?? addMonths(inicio, durMeses);
  protocol.metadata.fecha_revision = formatDateWithWeekday(revision, idioma);

  return protocol;
}
