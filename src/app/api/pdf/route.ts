import { getSession } from "@/lib/session";
import { createAdminClient } from "@/utils/supabase/admin";
import { buildProtocolHTML } from "@/lib/protocol-template";
import { ProtocoloData } from "@/lib/protocol-types";
import { uploadPDFToDrive, isDriveConfigured } from "@/lib/drive";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import puppeteer from "puppeteer";

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

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await browser.close();

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
