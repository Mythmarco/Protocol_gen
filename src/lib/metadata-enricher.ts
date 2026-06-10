import type { ProtocoloData } from "./protocol-types";

// Server-side enrichment of protocol metadata. Run after the AI returns its
// finalize_protocol JSON, BEFORE rendering the PDF. We do this server-side
// so dates and creator email are guaranteed correct — never trust the model
// to know today's date or who is logged in.
//
// All dates here are treated as CALENDAR DATES in the clinic's local
// timezone, NEVER as instants in UTC. Vercel runs in UTC, so any naive use
// of `new Date()` + `getDate()` produces the WRONG day after 18:00 MX time.
// We work in {year, month, day} components and only construct a Date when
// we need weekday lookup, which we do consistently via UTC noon.

const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Mexico_City";

// Tipo de cambio MXN/USD por DEFAULT (último recurso si el caller no pasa
// uno explícito). El catálogo está en MXN; cuando el doctor pide USD,
// convertimos server-side aquí. La resolución completa del rate vive en
// src/lib/settings.ts: doctor-specific (BD) → env → este default.
//
// El caller (pdf/route.ts, preview/route.ts) carga el rate del doctor
// con getDoctorFxRate(session.id) y lo pasa como options.fxRate. Si NO
// lo pasa (por compatibilidad con código viejo o tests), caemos a env.
const DEFAULT_FX_FALLBACK =
  Number(process.env.PEPTIDES_MXN_PER_USD || "18.5") || 18.5;

interface CalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

// "Today" en la zona horaria de la clínica — extraído via Intl, no via
// getDate() del servidor (que en Vercel sería UTC).
function todayInZone(timeZone: string): CalDate {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}

// Convierte componentes calendario a un Date posicionado al mediodía UTC.
// Mediodía UTC nunca cruza fronteras de día en ninguna zona horaria del
// continente americano (UTC-3 a UTC-10), así que getUTCDay() devuelve el
// día calendario correcto sin importar dónde corra el código.
function calToUtcNoon(c: CalDate): Date {
  return new Date(Date.UTC(c.year, c.month - 1, c.day, 12, 0, 0));
}

function weekdayOf(c: CalDate): number {
  return calToUtcNoon(c).getUTCDay();
}

// Formato "14/05/2026 (jueves)".
function formatDateWithWeekday(c: CalDate, idioma: "es" | "en"): string {
  const dd = String(c.day).padStart(2, "0");
  const mm = String(c.month).padStart(2, "0");
  const weekday = (idioma === "en" ? WEEKDAYS_EN : WEEKDAYS_ES)[weekdayOf(c)];
  return `${dd}/${mm}/${c.year} (${weekday})`;
}

// ISO YYYY-MM-DD en la zona local (NO UTC). Va a metadata.fecha, al nombre
// del archivo, y al folder de Drive.
function isoDate(c: CalDate): string {
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

// Parsear lo que el modelo escribió. Acepta YYYY-MM-DD, DD/MM/YYYY, y
// formato con sufijo "(weekday)". Devuelve componentes; null si no parseable.
function tryParseCalDate(s: string | undefined | null): CalDate | null {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/\s*\([^)]*\)\s*$/, "").trim();

  const iso = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  const ddmm = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmm) {
    return { year: Number(ddmm[3]), month: Number(ddmm[2]), day: Number(ddmm[1]) };
  }

  // Fallback: parse via Date pero asumiendo que el string ya estaba en
  // formato de zona local. Si Date lo interpreta como UTC, extraemos los
  // componentes UTC — preserva el día tal como aparecía en el texto.
  const parsed = new Date(cleaned);
  if (!Number.isFinite(parsed.getTime())) return null;
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
}

// Suma N meses a un calendario, manejando overflow de mes correctamente.
// Ej: addMonths({2026, 1, 31}, 1) → {2026, 2, 28} (no 3 de marzo).
function addMonthsCal(c: CalDate, months: number): CalDate {
  const totalMonths = (c.year * 12 + (c.month - 1)) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  // Cap day to last day of target month
  const daysInMonth = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
  return { year: newYear, month: newMonth, day: Math.min(c.day, daysInMonth) };
}

export function enrichProtocolMetadata(
  protocol: ProtocoloData,
  doctor: { name: string; email: string; fxRate?: number }
): ProtocoloData {
  const today = todayInZone(APP_TIMEZONE);
  const idioma: "es" | "en" = protocol.metadata?.idioma === "en" ? "en" : "es";

  // ── creado_por: ALWAYS the signed-in doctor ──
  protocol.metadata.creado_por = doctor.email;
  protocol.metadata.idioma = idioma;
  if (!protocol.metadata.version) protocol.metadata.version = "1.0";

  // ── fecha (today's date in local zone, ISO format) ──
  protocol.metadata.fecha = isoDate(today);

  // ── fecha_inicio: AI's value if parseable, else today ──
  const inicio = tryParseCalDate(protocol.metadata.fecha_inicio) ?? today;
  protocol.metadata.fecha_inicio = formatDateWithWeekday(inicio, idioma);

  // ── fecha_revision: AI's value if parseable, else inicio + duracion_meses ──
  const durMeses = Math.max(1, protocol.protocolo?.duracion_meses ?? 1);
  const revision =
    tryParseCalDate(protocol.metadata.fecha_revision) ??
    addMonthsCal(inicio, durMeses);
  protocol.metadata.fecha_revision = formatDateWithWeekday(revision, idioma);

  // ── MXN → USD: si el doctor pidió USD, convertimos AQUÍ los precios
  //    que el modelo dejó en MXN. El prompt obliga al modelo a NO
  //    convertir (regla 6). El FX se resuelve en orden:
  //      doctor.fxRate (pasado por el caller desde getDoctorFxRate) →
  //      env PEPTIDES_MXN_PER_USD → 18.5
  const effectiveFx =
    doctor.fxRate && doctor.fxRate > 0 ? doctor.fxRate : DEFAULT_FX_FALLBACK;
  if (protocol.cotizacion?.moneda === "USD" && effectiveFx > 0) {
    const toUsd = (mxn: number) =>
      Math.round((mxn / effectiveFx) * 100) / 100;
    if (Array.isArray(protocol.cotizacion.productos)) {
      protocol.cotizacion.productos = protocol.cotizacion.productos.map((p) => ({
        ...p,
        precio_unitario: toUsd(Number(p.precio_unitario) || 0),
      }));
    }
    if (typeof protocol.cotizacion.descuento === "number") {
      protocol.cotizacion.descuento = toUsd(protocol.cotizacion.descuento);
    }
    if (typeof protocol.cotizacion.envio_monto === "number") {
      protocol.cotizacion.envio_monto = toUsd(protocol.cotizacion.envio_monto);
    }
    if (typeof protocol.cotizacion.total === "number") {
      protocol.cotizacion.total = toUsd(protocol.cotizacion.total);
    }
    // Nota explícita en la cotización para que el doctor sepa cuál FX se
    // usó (auditable). Se prepende a la nota que el modelo haya escrito —
    // PERO si el modelo ya escribió una nota de "Tipo de cambio aplicado"
    // (lo hace a veces pese a la regla 6 del prompt), la sobrescribimos
    // limpia en lugar de duplicar. El PDF de Marco salía con la frase
    // dos veces.
    const fxNote = `Tipo de cambio aplicado: ${effectiveFx.toFixed(2)} MXN/USD. Confirmar al cobrar.`;
    const existing = protocol.cotizacion.nota ?? "";
    // Strip cualquier mención previa de "Tipo de cambio aplicado: ... MXN/USD."
    // (con o sin "Confirmar al cobrar.") que el modelo pudo haber metido.
    const cleaned = existing
      .replace(
        /Tipo de cambio aplicado:\s*\d+(?:\.\d+)?\s*MXN\/USD\.?(\s*Confirmar al cobrar\.?)?/gi,
        ""
      )
      .replace(/\s{2,}/g, " ")
      .trim();
    protocol.cotizacion.nota = cleaned ? `${fxNote} ${cleaned}` : fxNote;
  }

  return protocol;
}
