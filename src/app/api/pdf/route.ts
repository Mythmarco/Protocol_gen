import { getSession } from "@/lib/session";
import { createAdminClient } from "@/utils/supabase/admin";
import { buildProtocolHTML } from "@/lib/protocol-template";
import { ProtocoloData } from "@/lib/protocol-types";
import { uploadPDFToDrive, isDriveConfigured } from "@/lib/drive";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

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

  const {
    protocolData,
    conversacion,
    conversacion_modo,
    mode,
  } = (await req.json()) as {
    protocolData: ProtocoloData;
    conversacion?: Array<{ role: "user" | "assistant"; content: string }>;
    conversacion_modo?: "text" | "voice";
    // "save"     → reserve folio + upload to Drive + insert row (default)
    // "download" → just render the PDF and return it; no side effects.
    //              Used to re-download a protocol that was already archived.
    mode?: "save" | "download";
  };
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

  let pdf: Uint8Array;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    console.log("[pdf] launching browser…");
    browser = await launchBrowser();
    console.log("[pdf] browser launched, rendering page");
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    console.log(`[pdf] rendered ${pdf.byteLength} bytes`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[pdf] puppeteer failure:", detail, err);
    return new Response(`Puppeteer error: ${detail}`, { status: 500 });
  } finally {
    try { await browser?.close(); } catch {}
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
      console.error("[pdf] Drive upload failed:", err);
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
    console.error("[pdf] Supabase insert failed (full error):", JSON.stringify(insertError, null, 2));
  } else {
    console.log(`[pdf] saved to Supabase id=${inserted?.id} folio=${folio}`);
  }

  return new Response(pdf.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      // Surface metadata the client uses for the success toast
      "X-Folio": folio,
      "X-Drive-Url": driveUrl ?? "",
      "Access-Control-Expose-Headers": "X-Folio, X-Drive-Url",
    },
  });
}
