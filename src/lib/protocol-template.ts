import { ProtocoloData } from "./protocol-types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Embed brand assets as base64 data URIs so the PDF is self-contained,
// regardless of where Puppeteer runs (local dev, Vercel, etc.).
let cachedLogo: string | null = null;
let cachedSyringe: string | null = null;

function getLogoDataURI(): string {
  if (cachedLogo) return cachedLogo;
  const svg = readFileSync(join(process.cwd(), "public/peptides-logo.svg"), "utf8");
  cachedLogo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return cachedLogo;
}

function getSyringeDataURI(): string {
  if (cachedSyringe) return cachedSyringe;
  const png = readFileSync(join(process.cwd(), "public/syringe-05ml-31g.png"));
  cachedSyringe = `data:image/png;base64,${png.toString("base64")}`;
  return cachedSyringe;
}

// ASCII keys (Miercoles/Sabado) because that's what the schema uses (strict mode
// can't have accented identifiers). Display labels use accents in the LABELS table.
const DIAS_KEYS = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"] as const;

const LABELS = {
  es: {
    htmlLang: "es",
    docTitlePrefix: "",
    protocolTitle: "Protocolo de Administración de Péptidos",
    quoteTitle: "Cotización de Productos",
    version: "Versión",
    start: "Inicio",
    nextReview: "Próxima revisión",
    quoteDate: "Fecha cotización",
    client: "Cliente",
    patientData: "Datos del Paciente",
    name: "Nombre",
    weight: "Peso actual",
    height: "Estatura",
    age: "Edad",
    objective: "Objetivo clínico",
    peptidePlan: "Plan de Péptidos",
    weeklySchedule: "Calendario Semanal Sugerido",
    syringePrep: "Unidades de jeringa y preparación",
    reconstitution: "Reconstitución y conservación",
    generalIndications: "Indicaciones generales y seguimiento",
    stackExplanation: "Explicación del Stack",
    th: { peptide: "Péptido", dose: "Dosis prescrita", units: "Unidades (jeringa 0.5 mL)", frequency: "Frecuencia", cycle: "Ciclo / indicación" },
    weekdays: ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"],
    quoteThead: { product: "Producto", qty: "Cantidad", priceUnit: "Precio Unitario", lineTotal: "Total" },
    folio: "Folio", date: "Fecha", description: "Descripción", toBeAssigned: "Por asignar",
    shipping: "Envío", discount: "Descuento", total: "TOTAL",
    customizedPlan: "Plan personalizado para este paciente. Ajustar solo por indicación clínica.",
    syringeBullets: [
      "<strong>Jeringa para reconstitución:</strong> usar la jeringa de <strong>3 mL</strong> incluida en el paquete.",
      "<strong>Jeringa para aplicación recomendada:</strong> jeringa de insulina de <strong>0.5 mL (hasta 50 unidades)</strong>.",
      "<strong>Vía de administración en este protocolo:</strong> <strong>subcutánea</strong>.",
      "<strong>Reconstitución sugerida:</strong> 2 mL de agua bacteriostática por vial.",
    ],
    syringeSpec: "6mm × 31G (15/64in length needle × 0.25mm) 1/2mL syringe up to 50 units.",
    reconstitutionBullets: [
      "Se enviarán los péptidos con <strong>agua bacteriostática</strong> para reconstitución.",
      "Desinfectar tapas de viales con alcohol antes de perforar.",
      "Introducir el agua lentamente por la pared interna del vial.",
      '<strong>Girar suavemente</strong> el vial para mezclar. <span class="highlight">No agitar fuerte.</span>',
      "Conservar los viales reconstituidos en refrigeración (2-8 °C), preferentemente al <strong>fondo del refrigerador</strong>, no en la puerta.",
      "No congelar. Proteger de luz/calor. Desechar si hay partículas, cambio de color o dudas de esterilidad.",
    ],
    footer: "Este formato es una guía de seguimiento para pacientes de Peptides4ALL y debe individualizarse por el profesional de salud.",
    quoteFooterBase: "Montos expresados en la moneda indicada.",
    quoteFooterFreeShipping: "Envío incluido como cortesía.",
    syringeAlt: "Jeringa 1/2 mL 50 unidades 31G × 6mm",
    locale: "es-MX",
  },
  en: {
    htmlLang: "en",
    docTitlePrefix: "",
    protocolTitle: "Peptide Administration Protocol",
    quoteTitle: "Product Quote",
    version: "Version",
    start: "Start",
    nextReview: "Next review",
    quoteDate: "Quote date",
    client: "Client",
    patientData: "Patient Data",
    name: "Name",
    weight: "Current weight",
    height: "Height",
    age: "Age",
    objective: "Clinical objective",
    peptidePlan: "Peptide Plan",
    weeklySchedule: "Suggested Weekly Schedule",
    syringePrep: "Syringe units and preparation",
    reconstitution: "Reconstitution and storage",
    generalIndications: "General indications and follow-up",
    stackExplanation: "Stack Explanation",
    th: { peptide: "Peptide", dose: "Prescribed dose", units: "Units (0.5 mL syringe)", frequency: "Frequency", cycle: "Cycle / indication" },
    weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    quoteThead: { product: "Product", qty: "Qty", priceUnit: "Unit Price", lineTotal: "Total" },
    folio: "Folio", date: "Date", description: "Description", toBeAssigned: "To be assigned",
    shipping: "Shipping", discount: "Discount", total: "TOTAL",
    customizedPlan: "Personalized plan for this patient. Adjust only based on clinical indication.",
    syringeBullets: [
      "<strong>Reconstitution syringe:</strong> use the <strong>3 mL</strong> syringe included in the kit.",
      "<strong>Recommended application syringe:</strong> <strong>0.5 mL insulin syringe (up to 50 units)</strong>.",
      "<strong>Route of administration in this protocol:</strong> <strong>subcutaneous</strong>.",
      "<strong>Suggested reconstitution:</strong> 2 mL bacteriostatic water per vial.",
    ],
    syringeSpec: "6mm × 31G (15/64in length needle × 0.25mm) 1/2mL syringe up to 50 units.",
    reconstitutionBullets: [
      "Peptides will be shipped with <strong>bacteriostatic water</strong> for reconstitution.",
      "Disinfect vial caps with alcohol before piercing.",
      "Introduce water slowly along the inner wall of the vial.",
      '<strong>Swirl gently</strong> to mix. <span class="highlight">Do not shake vigorously.</span>',
      "Store reconstituted vials refrigerated (2-8 °C), preferably at the <strong>back of the refrigerator</strong>, not the door.",
      "Do not freeze. Protect from light/heat. Discard if particles, color change or sterility doubts.",
    ],
    footer: "This format is a patient follow-up guide for Peptides4ALL and must be individualized by the health professional.",
    quoteFooterBase: "Amounts in the indicated currency.",
    quoteFooterFreeShipping: "Shipping included as courtesy.",
    syringeAlt: "1/2 mL 50-unit 31G × 6mm syringe",
    locale: "en-US",
  },
} as const;

export interface BuildOptions {
  doctor?: { name: string; email: string };
}

export function buildProtocolHTML(data: ProtocoloData, options: BuildOptions = {}): string {
  const { paciente, protocolo, cotizacion, metadata } = data;
  const L = LABELS[metadata.idioma === "en" ? "en" : "es"];
  const logoURI = getLogoDataURI();
  const syringeURI = getSyringeDataURI();
  const doctorAttribution = options.doctor
    ? (metadata.idioma === "en" ? "Issued by" : "Atendido por") +
      ` <strong>${options.doctor.name || options.doctor.email.split("@")[0]}</strong>`
    : "";

  const peptidoRows = protocolo.peptidos
    .map(
      (p) => `
    <tr>
      <td><strong>${p.nombre}</strong></td>
      <td>${p.dosis}</td>
      <td>${p.unidades}</td>
      <td>${p.frecuencia}</td>
      <td>${p.ciclo}</td>
    </tr>`
    )
    .join("");

  // Calendar is now an array of {peptido_label, Lunes..Domingo}. Render in row order.
  const calendarRows = protocolo.calendario
    .map((entry) => `
    <tr>
      <td>${entry.peptido_label}</td>
      ${DIAS_KEYS.map((d) => `<td>${entry[d] ?? "—"}</td>`).join("")}
    </tr>`)
    .join("");

  // Convert metadata.fecha (ISO YYYY-MM-DD) to pretty DD/MM/YYYY for display.
  const fechaDisplay = (() => {
    const f = metadata.fecha ?? "";
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : f;
  })();

  const moneda = data.cotizacion.moneda ?? "MXN";
  // Formato moneda explícito: MX$ vs US$ para eliminar ambigüedad. Intl
  // localiza el número (1,234.50 vs 1.234,50) pero el prefijo lo escribimos
  // a mano para garantizar consistencia visual MX$/US$ siempre.
  const currencyPrefix = moneda === "USD" ? "US$" : "MX$";
  const numberLocale = moneda === "USD" ? "en-US" : "es-MX";
  const money = (n: number) =>
    `${currencyPrefix} ${n.toLocaleString(numberLocale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const indicacionesItems = protocolo.indicaciones_generales
    .map((i) => `<li>${i}</li>`)
    .join("");

  const stackItems = protocolo.explicacion_stack
    .map((i) => `<li>${i}</li>`)
    .join("");

  const cotizacionRows = cotizacion.productos
    .map(
      (p) => `
    <tr>
      <td>${p.nombre}</td>
      <td>${p.qty}</td>
      <td>${money(p.precio_unitario)}</td>
      <td>${money(p.precio_unitario * p.qty)}</td>
    </tr>`
    )
    .join("");

  const totalLine = `<div class="quote-summary-row"><div>${L.total} ${moneda}:</div><div>${money(cotizacion.total)}</div></div>`;

  const discountLine =
    cotizacion.descuento > 0
      ? `<div class="quote-summary-row discount"><div>${L.discount}:</div><div>-${money(cotizacion.descuento)}</div></div>`
      : "";

  // Shipping rendering driven by envio_tipo:
  //  - "gratis"    → "Gratis" line + courtesy footer
  //  - "costo"     → formatted amount, no courtesy footer (already in total)
  //  - "no_aplica" → no shipping line, no courtesy footer
  const envioTipo = cotizacion.envio_tipo;
  const envioMonto = cotizacion.envio_monto ?? 0;

  const freeLabel = metadata.idioma === "en" ? "Free" : "Gratis";
  let envioLine = "";
  if (envioTipo === "gratis") {
    envioLine = `<div class="quote-summary-row"><div>${L.shipping}:</div><div>${freeLabel}</div></div>`;
  } else if (envioTipo === "costo") {
    envioLine = `<div class="quote-summary-row"><div>${L.shipping}:</div><div>${money(envioMonto)}</div></div>`;
  }
  // "no_aplica" → envioLine stays empty

  const quoteFooter =
    envioTipo === "gratis"
      ? `${L.quoteFooterBase} ${L.quoteFooterFreeShipping}`
      : L.quoteFooterBase;

  return `<!doctype html>
<html lang="${L.htmlLang}">
<head>
  <meta charset="UTF-8"/>
  <!-- width=794 = ancho de A4 a 96dpi. SIN initial-scale a propósito —
       Safari/Chrome calculan initial-scale = device-width / 794 para que la
       página arranque ajustada al ancho de pantalla. Si forzamos
       initial-scale=1 la página empieza al 100% (más ancha que el celular)
       y el usuario tiene que pinch-out para ver el contenido completo. -->
  <meta name="viewport" content="width=794, user-scalable=yes, maximum-scale=5.0, minimum-scale=0.3"/>
  <!-- Fonts: DM Sans (texto) + Plus Jakarta Sans (títulos). Chromium en
       Vercel serverless no tiene fonts del sistema, así que cargamos por red
       y el route hace setContent waitUntil:networkidle0 para garantizar que
       lleguen antes de imprimir. Antes el PDF caía a Segoe/sans-serif. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
  <title>${paciente.nombre} | Peptides4ALL</title>
  <style>
    :root{--brand-dark:#504d4d;--brand-gold:#f2b056;--brand-gold-deep:#d9943f;--brand-gold-light:#f8d9a0;--brand-silver:#b2b0ae;--brand-warm-gray:#d7d5d3;--brand-off-white:#f8f7f6;--ink:#2f2d2d;--muted:#6b6868;--ok:#0f766e;--warning:#9a3412}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;color:var(--ink);background:#f5f3f1;font-family:"DM Sans","Plus Jakarta Sans","Segoe UI",sans-serif;line-height:1.4}
    .page{width:210mm;min-height:297mm;margin:16px auto;padding:18mm 16mm 16mm;background:#fff;box-shadow:0 22px 50px rgba(34,30,28,.12);position:relative;overflow:hidden}
    /* Decoración solo en pantalla. En PDF estos gradientes radiales se
       convertían en objetos vectoriales pesados que hacían el scroll
       extremadamente lento en el visor de Chrome (cada repaint
       rasterizaba el gradiente entero). En PDF el fondo blanco basta. */
    @media screen{
      html,body{background:radial-gradient(circle at 100% 0%,rgba(242,176,86,.08),transparent 38%),#f5f3f1}
      .page::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 0% 0%,rgba(242,176,86,.12),transparent 35%),linear-gradient(140deg,rgba(255,255,255,0),rgba(242,176,86,.04));z-index:0}
    }
    .content{position:relative;z-index:1}
    .header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:12px;border-bottom:2px solid var(--brand-warm-gray)}
    .brand-row{display:flex;align-items:center;gap:10px}
    .brand-logo{width:200px;max-width:100%;height:auto;display:block}
    .doc-meta{text-align:right;font-size:12px;color:var(--muted);min-width:210px}
    h1{margin:14px 0 4px;font-size:26px;font-family:"Plus Jakarta Sans","DM Sans",sans-serif;letter-spacing:-.02em;color:var(--brand-dark)}
    .section{margin-top:14px}
    .section-title{margin:0 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--brand-gold-deep);font-weight:800}
    .card{border:1px solid var(--brand-warm-gray);border-radius:12px;padding:10px;background:linear-gradient(180deg,#fff 0%,var(--brand-off-white) 100%)}
    .patient-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .field{border:1px solid #e3e1df;border-radius:10px;padding:8px;background:#fff;min-height:52px}
    .field .label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;font-weight:700}
    .field .value{font-size:14px;font-weight:700;color:var(--brand-dark)}
    table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
    .table-wrap{border:1px solid #dfdddb;border-radius:10px;overflow:hidden;background:#fff}
    .protocol-table th,.protocol-table td,.schedule-table th,.schedule-table td{border-right:1px solid #dfdddb;border-bottom:1px solid #dfdddb;padding:7px;vertical-align:top}
    .protocol-table tr>*:last-child,.schedule-table tr>*:last-child{border-right:0}
    .protocol-table tbody tr:last-child td,.schedule-table tbody tr:last-child td{border-bottom:0}
    .protocol-table th,.schedule-table th{background:#f8efe2;color:#5a4e3f;font-weight:800;text-transform:uppercase;letter-spacing:.05em;font-size:10px}
    .protocol-table td strong{color:var(--brand-dark)}
    /* Highlight de la columna "Unidades de jeringa" — es el dato clínico
       más crítico del PDF (lo que el paciente lee para preparar la inyección).
       Background ámbar + font más grande + bold para que destaque del resto. */
    .protocol-table th:nth-child(3),
    .protocol-table td:nth-child(3){
      background:#fdf2dd;
      font-weight:800;
      font-size:13px;
      color:#7a5a25;
      text-align:center;
    }
    .protocol-table th:nth-child(3){font-size:10px}
    .schedule-table{font-size:11px;table-layout:fixed}
    .schedule-table td{text-align:center;font-weight:700}
    .schedule-table td:first-child,.schedule-table th:first-child{text-align:left;width:118px;font-weight:800}
    .two-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
    .two-cols>.card{display:block}
    .bullet-list{margin:0;padding-left:17px;font-size:12px}
    .bullet-list li+li{margin-top:5px}
    .highlight{color:var(--warning);font-weight:700}
    .small-note{margin-top:6px;font-size:10px;color:var(--muted)}
    .syringe-spec{margin-top:9px;font-size:11px;color:var(--brand-dark);font-weight:700}
    .syringe-image{display:block;width:100%;height:auto;max-height:80px;object-fit:contain;margin-top:10px;border:1px solid #dfdddb;border-radius:8px;background:#fff;padding:6px}
    .post-calendar-page,.quote-page{margin-top:14px}
    .quote-table{font-size:12px;table-layout:fixed}
    .quote-table th,.quote-table td{border-right:1px solid #dfdddb;border-bottom:1px solid #dfdddb;padding:8px}
    .quote-table th{background:#f8efe2;color:#5a4e3f;text-transform:uppercase;font-size:10px;font-weight:800;letter-spacing:.05em;text-align:center}
    .quote-table tr>*:last-child{border-right:0}
    .quote-table tbody tr:last-child td{border-bottom:0}
    .quote-table td:nth-child(1){text-align:left}
    .quote-table td:nth-child(2){text-align:center;width:76px}
    .quote-table td:nth-child(3),.quote-table td:nth-child(4){text-align:right;width:188px}
    .quote-meta-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .quote-summary{width:460px;margin-left:auto;border:1px solid #dfdddb;border-radius:10px;overflow:hidden;background:#fff}
    /* Label angosto (160px) + valor amplio (resto) en flex para que el monto
       siempre quepa en una línea. nowrap como red de seguridad por si el
       texto pasa el ancho (Intl produce "MX$ 1,234,567.89" tipo). */
    .quote-summary-row{display:grid;grid-template-columns:160px 1fr;min-height:40px;border-bottom:1px solid #dfdddb;font-size:13px;color:var(--brand-dark);font-weight:600}
    .quote-summary-row:last-child{border-bottom:0;background:#f8efe2;font-weight:800;font-size:22px;min-height:56px}
    .quote-summary-row>div{display:flex;align-items:center;justify-content:flex-end;padding:0 12px;background:#fff;white-space:nowrap}
    .quote-summary-row:last-child>div{background:#f8efe2}
    .quote-summary-row>div:last-child{border-left:1px solid #dfdddb;justify-content:flex-end;font-weight:700}
    .quote-summary-row.discount>div:last-child{color:var(--warning)}
    .footer{margin-top:12px;padding-top:8px;border-top:1px solid #e7e4e1;font-size:10px;color:var(--muted);display:flex;justify-content:space-between;gap:12px}
    .stack-section,.stack-section .card,.indicaciones-section,.indicaciones-section .card{break-inside:avoid-page;page-break-inside:avoid}
    /* Puppeteer maneja los márgenes vía displayHeaderFooter — no fijamos
       margin en @page. El padding interno de .page en print se reduce porque
       el header/footer de Puppeteer ya ocupan ~14mm arriba y ~12mm abajo. */
    @page{size:A4}
    @media print{
      body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .page{margin:0;width:100%;min-height:auto;box-shadow:none;padding:6mm 10mm 6mm}
      .post-calendar-page,.quote-page{page-break-before:always;break-before:page;margin-top:0}
      main.page.protocol-page .footer{display:none}
    }
  </style>
</head>
<body>
  <!-- PAGE 1: Protocol -->
  <main class="page protocol-page">
    <div class="content">
      <header class="header">
        <div class="brand">
          <div class="brand-row">
            <img class="brand-logo" src="${logoURI}" alt="Peptides4ALL"/>
          </div>
          <h1>${L.protocolTitle}</h1>
        </div>
        <div class="doc-meta">
          <div><strong>${L.version}:</strong> ${metadata.version}</div>
          <div><strong>${L.start}:</strong> ${metadata.fecha_inicio}</div>
          <div><strong>${L.nextReview}:</strong> ${metadata.fecha_revision}</div>
        </div>
      </header>

      <section class="section">
        <h2 class="section-title">${L.patientData}</h2>
        <div class="card patient-grid">
          <div class="field"><div class="label">${L.name}</div><div class="value">${paciente.nombre}</div></div>
          <div class="field"><div class="label">${L.weight}</div><div class="value">${paciente.peso}</div></div>
          <div class="field"><div class="label">${L.height}</div><div class="value">${paciente.estatura}</div></div>
          <div class="field"><div class="label">${L.age}</div><div class="value">${paciente.edad}</div></div>
        </div>
        <p class="small-note"><strong>${L.objective}:</strong> ${paciente.objetivo}</p>
      </section>

      <section class="section">
        <h2 class="section-title">${L.peptidePlan}</h2>
        <div class="card">
          <div class="table-wrap">
            <table class="protocol-table">
              <thead>
                <tr>
                  <th>${L.th.peptide}</th><th>${L.th.dose}</th><th>${L.th.units}</th><th>${L.th.frequency}</th><th>${L.th.cycle}</th>
                </tr>
              </thead>
              <tbody>${peptidoRows}</tbody>
            </table>
          </div>
          <p class="small-note">${L.customizedPlan}</p>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">${L.weeklySchedule}</h2>
        <div class="card">
          <div class="table-wrap">
            <table class="schedule-table">
              <thead>
                <tr>
                  <th>${L.th.peptide}</th>${L.weekdays.map((d) => `<th>${d}</th>`).join("")}
                </tr>
              </thead>
              <tbody>${calendarRows}</tbody>
            </table>
          </div>
          <p class="small-note">${protocolo.nota_calendario}</p>
        </div>
      </section>
    </div>
  </main>

  <!-- PAGE 2: Instructions -->
  <main class="page post-calendar-page">
    <div class="content">
      <section class="section two-cols">
        <div class="card">
          <h2 class="section-title">${L.syringePrep}</h2>
          <ul class="bullet-list">
            ${L.syringeBullets.map((b) => `<li>${b}</li>`).join("")}
          </ul>
          <p class="syringe-spec">${L.syringeSpec}</p>
          <img class="syringe-image" src="${syringeURI}" alt="${L.syringeAlt}"/>
        </div>
        <div class="card">
          <h2 class="section-title">${L.reconstitution}</h2>
          <ul class="bullet-list">
            ${L.reconstitutionBullets.map((b) => `<li>${b}</li>`).join("")}
          </ul>
        </div>
      </section>

      <section class="section indicaciones-section">
        <div class="card">
          <h2 class="section-title">${L.generalIndications}</h2>
          <ul class="bullet-list">${indicacionesItems}</ul>
        </div>
      </section>

      <section class="section stack-section">
        <div class="card">
          <h2 class="section-title">${L.stackExplanation}</h2>
          <ul class="bullet-list">${stackItems}</ul>
        </div>
      </section>

      <footer class="footer">
        <div>${L.footer}</div>
      </footer>
    </div>
  </main>

  <!-- PAGE 3: Quote -->
  <main class="page quote-page">
    <div class="content">
      <header class="header">
        <div class="brand">
          <div class="brand-row">
            <img class="brand-logo" src="${logoURI}" alt="Peptides4ALL"/>
          </div>
          <h1>${L.quoteTitle}</h1>
        </div>
        <div class="doc-meta">
          <div><strong>${L.version}:</strong> ${metadata.version}</div>
          <div><strong>${L.quoteDate}:</strong> ${fechaDisplay}</div>
          <div><strong>${L.client}:</strong> ${paciente.nombre}</div>
        </div>
      </header>

      <section class="section">
        <h2 class="section-title">${cotizacion.descripcion}</h2>
        <div class="card">
          <div class="quote-meta-grid">
            <div class="field"><div class="label">${L.folio}</div><div class="value">${cotizacion.folio ?? L.toBeAssigned}</div></div>
            <div class="field"><div class="label">${L.date}</div><div class="value">${fechaDisplay}</div></div>
            <div class="field"><div class="label">${L.client}</div><div class="value">${paciente.nombre}</div></div>
            <div class="field"><div class="label">${L.description}</div><div class="value">${cotizacion.descripcion}</div></div>
          </div>
          <div class="section">
            <div class="table-wrap">
              <table class="quote-table">
                <thead>
                  <tr><th>${L.quoteThead.product}</th><th>${L.quoteThead.qty}</th><th>${L.quoteThead.priceUnit} (${moneda})</th><th>${L.quoteThead.lineTotal} (${moneda})</th></tr>
                </thead>
                <tbody>${cotizacionRows}</tbody>
              </table>
            </div>
          </div>
          <div class="section">
            <div class="quote-summary">
              ${envioLine}
              ${discountLine}
              ${totalLine}
            </div>
            <p class="small-note">${cotizacion.nota}</p>
          </div>
        </div>
      </section>

      <footer class="footer">
        <div>${quoteFooter}</div>
        ${doctorAttribution ? `<div style="text-align:right">${doctorAttribution}</div>` : ""}
      </footer>
    </div>
  </main>
</body>
</html>`;
}
