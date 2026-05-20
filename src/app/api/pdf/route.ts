import { getSession } from "@/lib/session";
import { createAdminClient } from "@/utils/supabase/admin";
import { buildProtocolHTML } from "@/lib/protocol-template";
import { ProtocoloData } from "@/lib/protocol-types";
import { uploadPDFToDrive, isDriveConfigured } from "@/lib/drive";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import { z } from "zod";

// Zod schema mínimo de lo que /api/pdf REALMENTE lee del body. La forma
// completa de ProtocoloData la garantiza Structured Outputs del modelo —
// aquí solo guardamos los campos que el server toca directamente, para
// rechazar payloads malformed que harían crashear el render o ensuciar
// la columna `datos_json` de Supabase.
const PDF_REQUEST_SCHEMA = z.object({
  protocolData: z
    .object({
      paciente: z.object({ nombre: z.string().min(1).max(200) }).passthrough(),
      metadata: z.object({}).passthrough(),
      protocolo: z.object({ titulo: z.string().min(1).max(500) }).passthrough(),
      cotizacion: z.object({}).passthrough(),
    })
    .passthrough(),
  conversacion: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .max(500) // tope defensivo contra payloads gigantes
    .optional(),
  conversacion_modo: z.enum(["text", "voice"]).optional(),
  mode: z.enum(["save", "download"]).optional(),
});

// Vercel: dame hasta 60s. Puppeteer+Drive+Supabase encadenados sobrepasan
// fácil el default de 10s. (En plan Hobby el techo es 60s; en Pro 300s.)
export const maxDuration = 60;
// Forzar Node.js runtime — Edge no soporta Puppeteer.
export const runtime = "nodejs";

// URL remota del binario empaquetado de Chromium. Patrón recomendado de
// Sparticuz para Vercel: el binario NO se bundlea con el deploy (eso
// causaba el error "bin directory does not exist"), se descarga desde
// GitHub al primer cold start y se cachea en /tmp para invocaciones
// siguientes. La versión del tarball DEBE coincidir con la del paquete
// @sparticuz/chromium-min instalado.
const CHROMIUM_PACK_URL =
  process.env.CHROMIUM_PACK_URL ||
  "https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar";

async function launchBrowser() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: true,
    });
  }
  // Local: usa la instalación de `puppeteer` (devDependency) si está
  // disponible; si no, asume Chrome de macOS en su ruta canónica.
  let execPath: string | undefined;
  try {
    const localPuppeteer = (await import("puppeteer")) as unknown as {
      executablePath?: () => string;
      default?: { executablePath?: () => string };
    };
    execPath =
      localPuppeteer.executablePath?.() ??
      localPuppeteer.default?.executablePath?.();
  } catch {
    /* puppeteer no instalado en este entorno */
  }
  return puppeteer.launch({
    headless: true,
    executablePath:
      execPath || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  // Parse + validate. Si el body es JSON inválido o no matchea el schema,
  // 400 inmediato. Sin validación, un cliente podía mandar {} y reventar
  // el server, o inyectar cualquier objeto a `datos_json` de Supabase.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const parsed = PDF_REQUEST_SCHEMA.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.join(".") || "body";
    console.warn(
      `[pdf] body validation failed at ${path}: ${firstIssue?.message}`
    );
    return new Response(
      `Invalid body: ${path} — ${firstIssue?.message || "validation error"}`,
      { status: 400 }
    );
  }

  // El cast es seguro: zod ya validó la forma mínima. Los campos extra de
  // ProtocoloData están en passthrough, así que están presentes en runtime.
  const protocolData = parsed.data.protocolData as unknown as ProtocoloData;
  const { conversacion, conversacion_modo, mode } = parsed.data;
  const downloadOnly = mode === "download";

  // ── 0. Enrich metadata server-side (today's date, doctor email) ──
  enrichProtocolMetadata(protocolData, {
    name: session.name ?? "",
    email: session.email,
  });

  const supabase = createAdminClient();

  // ── 1. Folio: download mode reuses the one already stamped on the protocol;
  //         save mode reserves a fresh one from the Postgres sequence. ──
  let folio: string;
  if (downloadOnly) {
    folio = protocolData.cotizacion?.folio || `P4A-TMP-${Date.now()}`;
    console.log(`[pdf] download mode: reusing folio ${folio}`);
  } else {
    const { data: folioData, error: folioErr } = await supabase.rpc("next_protocol_folio");
    if (folioErr) {
      console.error("[pdf] folio rpc failed:", folioErr);
    }
    folio = typeof folioData === "string" ? folioData : `P4A-TMP-${Date.now()}`;
    console.log(`[pdf] folio assigned: ${folio}`);
    protocolData.cotizacion.folio = folio;
  }

  // ── 2. Render HTML → PDF ──
  const html = buildProtocolHTML(protocolData, {
    doctor: { name: session.name ?? "", email: session.email },
  });

  // Render PDF con cleanup robusto: cerramos page Y browser explícitamente,
  // ponemos timeouts agresivos para que un hung navigation no chupe los 60s
  // completos del function (matando otras requests en cold-warm scenarios).
  let pdf: Uint8Array;
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    console.log("[pdf] launching browser…");
    browser = await launchBrowser();
    console.log("[pdf] browser launched, rendering page");
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(30_000);
    // setContent en puppeteer-core 25 solo acepta "load"/"domcontentloaded"
     // (no "networkidle0"). Después esperamos explícitamente: (1) red
     // tranquila ≥500ms para fonts/CSS externos, (2) document.fonts.ready
     // para que las DM Sans/Plus Jakarta carguen antes del print. Antes el
     // PDF salía con Segoe (fallback de Chromium serverless).
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page
      .waitForNetworkIdle({ idleTime: 500, timeout: 10_000 })
      .catch(() => undefined);
    await page.evaluate(() => document.fonts.ready);

    // Sanitize header values to safe text en el header template HTML.
    const escapeHTML = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const headerFolio = escapeHTML(folio);
    const headerPaciente = escapeHTML(protocolData.paciente.nombre);

    // headerTemplate y footerTemplate son HTML separados que Puppeteer
    // renderiza por página. Default font-size es 5px (inutilizable), hay
    // que setearlo explícito. Las clases .pageNumber y .totalPages las
    // rellena Puppeteer en cada página.
    const headerTemplate = `
      <div style="width:100%;font-size:9px;color:#888;padding:0 12mm;
                  display:flex;justify-content:space-between;align-items:center;
                  font-family:'DM Sans','Helvetica',sans-serif;">
        <span style="font-weight:600;color:#666;">${headerPaciente}</span>
        <span style="font-family:'Menlo','Courier New',monospace;font-weight:700;color:#d9943f;">${headerFolio}</span>
      </div>`;
    const footerTemplate = `
      <div style="width:100%;font-size:9px;color:#aaa;padding:0 12mm;
                  display:flex;justify-content:center;
                  font-family:'DM Sans','Helvetica',sans-serif;">
        <span>Pág <span class="pageNumber"></span> de <span class="totalPages"></span></span>
      </div>`;

    pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      // Espacio para header (top) y footer (bottom). El template HTML interno
      // ya redujo su padding @media print para que no haya doble margen.
      margin: { top: "14mm", right: "0", bottom: "12mm", left: "0" },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      timeout: 30_000,
    });
    console.log(`[pdf] rendered ${pdf.byteLength} bytes`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[pdf] puppeteer failure:", detail, err);
    return new Response(`Puppeteer error: ${detail}`, { status: 500 });
  } finally {
    // Cerrar page primero, después browser. Errores los suprimimos pero
    // los logueamos a debug para detectar leaks de zombie chromium.
    try { await page?.close(); } catch (e) { console.warn("[pdf] page.close warn:", e); }
    try { await browser?.close(); } catch (e) { console.warn("[pdf] browser.close warn:", e); }
  }

  // ── 3. Build filename: folio + patient + date ──
  const nombreSlug = protocolData.paciente.nombre
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const fileName = `${folio}-${nombreSlug}-${protocolData.metadata.fecha}.pdf`;

  // ── 4. Download mode: short-circuit — no Drive, no Supabase. ──
  if (downloadOnly) {
    console.log(`[pdf] download mode: returning ${pdf.byteLength} bytes for ${folio}`);
    return new Response(pdf.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Folio": folio,
        "Access-Control-Expose-Headers": "X-Folio",
      },
    });
  }

  // ── 4. Upload to Drive (best-effort) ──
  // Rastreamos fallos en una lista para devolverlos al cliente. NUNCA
  // mentimos sobre el estado del save: si Drive O Supabase fallan, el
  // cliente verá un toast de warning en lugar del verde de éxito.
  const saveErrors: string[] = [];
  let driveUrl: string | null = null;
  if (isDriveConfigured()) {
    try {
      driveUrl = await uploadPDFToDrive({
        fileName,
        pdfBuffer: Buffer.from(pdf),
        patientName: protocolData.paciente.nombre,
      });
      console.log(`[pdf] uploaded to Drive: ${driveUrl}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pdf] Drive upload failed for folio=${folio}:`, msg, err);
      saveErrors.push(`Drive: ${msg}`);
    }
  } else {
    console.log("[pdf] Drive not configured — skipping upload");
  }

  // ── 5. Save index row in Supabase (with folio) ──
  const row = {
    folio,
    creado_por: session.id,
    paciente_nombre: protocolData.paciente.nombre,
    descripcion: `${protocolData.protocolo.titulo} — ${protocolData.metadata.fecha}`,
    datos_json: protocolData,
    drive_url: driveUrl,
    conversacion: Array.isArray(conversacion) ? conversacion : [],
    conversacion_modo: conversacion_modo === "voice" ? "voice" : "text",
    fecha_creacion: new Date().toISOString(),
  };

  console.log(
    `[pdf] inserting row: folio="${folio}" creado_por="${row.creado_por}" ` +
      `paciente="${row.paciente_nombre}" drive_url=${row.drive_url ? "set" : "null"}`
  );

  const { data: inserted, error: insertError } = await supabase
    .from("protocolos")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (insertError) {
    console.error(
      `[pdf] Supabase insert FAILED — folio=${folio} drive_url=${driveUrl ?? "null"} ` +
        `paciente="${protocolData.paciente.nombre}". MANUAL_RECONCILIATION_NEEDED. Error:`,
      JSON.stringify(insertError, null, 2)
    );
    saveErrors.push(`Supabase: ${insertError.message}`);
  } else {
    console.log(`[pdf] saved to Supabase id=${inserted?.id} folio=${folio}`);
  }

  const saveStatus = saveErrors.length === 0 ? "ok" : "failed";
  return new Response(pdf.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "X-Folio": folio,
      "X-Drive-Url": driveUrl ?? "",
      // El cliente lee X-Save-Status: si != "ok", muestra toast de warning
      // en lugar de éxito y opcionalmente lee X-Save-Error para mostrar el
      // motivo. Devolvemos el PDF igual — el doctor lo tiene en su mano,
      // pero le decimos honestamente que NO se archivó.
      "X-Save-Status": saveStatus,
      "X-Save-Error": saveErrors.join(" | "),
      "Access-Control-Expose-Headers":
        "X-Folio, X-Drive-Url, X-Save-Status, X-Save-Error",
    },
  });
}
