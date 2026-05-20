// Renders a sample PDF locally using the real protocol-template + puppeteer.
// Same code path as /api/pdf in prod, so what you see here is what the
// doctor sees from the live app. Run: npx tsx scripts/render-sample-pdf.ts

import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer";
import { buildProtocolHTML } from "../src/lib/protocol-template";
import type { ProtocoloData } from "../src/lib/protocol-types";

process.env.APP_TIMEZONE = "America/Mexico_City";

const sample: ProtocoloData = {
  paciente: {
    nombre: "Ana López Hernández",
    peso: "68 kg",
    estatura: "1.65 m",
    edad: "42 años",
    objetivo: "Energía sostenida, recuperación post-ejercicio y mejora de composición corporal",
  },
  protocolo: {
    titulo: "Stack Mes 1 — Energía + recuperación",
    duracion_meses: 1,
    mes_actual: 1,
    peptidos: [
      {
        nombre: "BPC-157",
        presentacion: "5 mg",
        dosis: "250 mcg AM / 250 mcg PM",
        unidades: "5 u",
        frecuencia: "Diario, 30 días",
        ciclo: "Día 1–30",
        reconstitucion: "2 mL agua bacteriostática",
        via: "subcutánea",
      },
      {
        nombre: "Retatrutida",
        presentacion: "15 mg",
        dosis: "4 mg semanal",
        unidades: "50 u (ajustado a capacidad de jeringa)",
        frecuencia: "Una vez por semana, viernes",
        ciclo: "Día 5, 12, 19, 26",
        reconstitucion: "2 mL agua bacteriostática",
        via: "subcutánea",
      },
      {
        nombre: "MOTS-c",
        presentacion: "20 mg",
        dosis: "2 mg",
        unidades: "20 u",
        frecuencia: "Lun, Mié, Vie",
        ciclo: "Día 1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26, 29",
        reconstitucion: "2 mL agua bacteriostática",
        via: "subcutánea",
      },
    ],
    calendario: [
      { peptido_label: "BPC-157 5 mg",      Lunes: "5 u AM/PM", Martes: "5 u AM/PM", Miercoles: "5 u AM/PM", Jueves: "5 u AM/PM", Viernes: "5 u AM/PM", Sabado: "5 u AM/PM", Domingo: "5 u AM/PM" },
      { peptido_label: "Retatrutida 15 mg", Lunes: "—",         Martes: "—",         Miercoles: "—",          Jueves: "—",         Viernes: "50 u",     Sabado: "—",         Domingo: "—" },
      { peptido_label: "MOTS-c 20 mg",      Lunes: "20 u",      Martes: "—",         Miercoles: "20 u",       Jueves: "—",         Viernes: "20 u",     Sabado: "—",         Domingo: "—" },
    ],
    nota_calendario: "Aplicar BPC-157 antes de comer. MOTS-c por la mañana, en ayunas. Retatrutida por la noche del viernes.",
    indicaciones_generales: [
      "Mantener hidratación adecuada durante todo el ciclo.",
      "Mínimo 7 horas de sueño consistente.",
      "Reportar cualquier reacción local persistente (>48 h) al médico tratante.",
      "Revisión clínica al cierre del mes 1 antes de continuar al mes 2.",
    ],
    explicacion_stack: [
      "BPC-157 actúa como agente sistémico de reparación tisular y modulación inflamatoria, complementando la fase regenerativa del paciente. Retatrutida proporciona el componente metabólico principal (GLP-1/GIP/glucagón) para mejora de composición corporal. MOTS-c interviene a nivel mitocondrial, mejorando el rendimiento energético y la sensibilidad a la insulina.",
      "La sinergia entre los tres péptidos cubre los tres ejes del objetivo: estructural (BPC), metabólico (Reta) y energético (MOTS-c), sin competencia farmacocinética entre ellos.",
    ],
  },
  cotizacion: {
    folio: "P4A-1042",
    descripcion: "Stack Mes 1 — Energía + recuperación",
    moneda: "MXN",
    productos: [
      { nombre: "BPC-157 5 mg",        qty: 2, precio_unitario: 850.0 },
      { nombre: "Retatrutida 15 mg",   qty: 1, precio_unitario: 4200.0 },
      { nombre: "MOTS-c 20 mg",        qty: 1, precio_unitario: 2150.0 },
      { nombre: "Agua bacteriostática 30 mL", qty: 1, precio_unitario: 280.0 },
    ],
    descuento: 0,
    envio_tipo: "costo",
    envio_monto: 600,
    total: 8930.0,
    nota: "",
  },
  metadata: {
    version: "1.0",
    fecha: "2026-05-19",
    fecha_inicio: "19/05/2026 (martes)",
    fecha_revision: "19/06/2026 (viernes)",
    creado_por: "marco@stacklabs.life",
    idioma: "es",
  },
};

async function main() {
  console.log("[render] building HTML…");
  const html = buildProtocolHTML(sample, {
    doctor: { name: "Dr. Marco Saenz", email: "marco@stacklabs.life" },
  });

  console.log("[render] launching local Chrome…");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(30_000);

  await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
  // Same wait strategy as /api/pdf — make Google Fonts arrive before PDF.
  await page
    .waitForNetworkIdle({ idleTime: 500, timeout: 10_000 })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);

  const headerTemplate = `
    <div style="width:100%;font-size:9px;color:#888;padding:0 12mm;
                display:flex;justify-content:space-between;align-items:center;
                font-family:'DM Sans','Helvetica',sans-serif;">
      <span style="font-weight:600;color:#666;">${sample.paciente.nombre}</span>
      <span style="font-family:'Menlo','Courier New',monospace;font-weight:700;color:#d9943f;">${sample.cotizacion.folio}</span>
    </div>`;
  const footerTemplate = `
    <div style="width:100%;font-size:9px;color:#aaa;padding:0 12mm;
                display:flex;justify-content:center;
                font-family:'DM Sans','Helvetica',sans-serif;">
      <span>Pág <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>`;

  console.log("[render] generating PDF…");
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", right: "0", bottom: "12mm", left: "0" },
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    timeout: 30_000,
  });
  await page.close();
  await browser.close();

  const outPath = "/tmp/peptides4all-sample.pdf";
  writeFileSync(outPath, pdf);
  console.log(`✓ ${outPath} — ${(pdf.byteLength / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
