import { getSession } from "@/lib/session";
import { buildProtocolHTML } from "@/lib/protocol-template";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import { getDoctorFxRate } from "@/lib/settings";
import type { ProtocoloData } from "@/lib/protocol-types";
import { z } from "zod";

// Returns the same HTML that will be turned into the PDF, so the client can
// show it inside an iframe before the doctor commits to "Guardar PDF".
//
// Hardening del workflow SOTA:
// - Validación zod del payload con .max() en cada string. Sin esto un
//   cliente comprometido podía mandar 50MB de datos crudos y volver el
//   render en un DoS o un vehículo de XSS más grande.
// - CSP estricta en la respuesta. El HTML del template usa Google Fonts
//   + data URIs para logo/jeringa + style inline, y CERO scripts. La
//   CSP refleja eso: si algún día el escape falla y alguien logra
//   inyectar <script>, no se ejecuta.
// - enrichProtocolMetadata se llama AQUÍ también para que preview muestre
//   exactamente la misma fecha/folio que el PDF final — antes preview
//   mostraba la fecha del modelo y el PDF la del servidor (mismatch).

const PROTOCOL_PREVIEW_SCHEMA = z.object({
  protocolData: z.object({
    paciente: z.object({
      nombre: z.string().max(120),
      peso: z.string().max(40),
      estatura: z.string().max(40),
      edad: z.string().max(40),
      objetivo: z.string().max(500),
    }),
    protocolo: z.object({
      duracion_meses: z.number().int().min(1).max(24),
      mes_actual: z.number().int().min(1).max(24),
      peptidos: z.array(z.any()).max(20),
      calendario: z.array(z.any()).max(20),
      nota_calendario: z.string().max(2000),
      indicaciones_generales: z.array(z.string().max(2000)).max(50),
      explicacion_stack: z.array(z.string().max(2000)).max(50),
    }),
    cotizacion: z.object({
      descripcion: z.string().max(500),
      moneda: z.enum(["MXN", "USD"]),
      productos: z.array(z.any()).max(30),
      descuento: z.number(),
      envio_tipo: z.enum(["gratis", "costo", "no_aplica"]),
      envio_monto: z.number(),
      total: z.number(),
      nota: z.string().max(2000),
      folio: z.string().max(60).optional().nullable(),
      // CRÍTICO: si NO está en el schema, zod lo strippea por default y
      // el enricher no lo ve → convierte los precios USD del doctor
      // como si fueran MXN. Bug reportado por Marco: PDF saved con
      // $382 correcto pero PREVIEW mostraba $23.15. Causa: /api/pdf
      // usa cotizacion.passthrough() (preserva extras), /api/preview
      // usa schema estricto que omitía este campo.
      skip_fx_conversion: z.boolean().optional(),
    }),
    metadata: z.object({
      idioma: z.enum(["es", "en"]),
      fecha: z.string().max(40).optional(),
      fecha_inicio: z.string().max(80).optional(),
      fecha_revision: z.string().max(80).optional(),
      version: z.string().max(20).optional(),
      creado_por: z.string().max(120).optional(),
      titulo: z.string().max(200).optional(),
    }),
  }).passthrough(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = PROTOCOL_PREVIEW_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    );
  }

  const protocolData = parsed.data.protocolData as unknown as ProtocoloData;
  // Enriquecer con fechas/FX server-side para que preview y PDF salgan
  // idénticos. Antes preview usaba la fecha del modelo y el PDF la del
  // servidor → confusión. FX cargado del doctor (settings) → env → default.
  const fxInfo = await getDoctorFxRate(session.id);
  enrichProtocolMetadata(protocolData, {
    name: session.name ?? "",
    email: session.email,
    fxRate: fxInfo.rate,
  });

  const html = buildProtocolHTML(protocolData, {
    doctor: { name: session.name ?? "", email: session.email },
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // CSP estricta. El template solo usa: data: URIs (logo, jeringa),
      // Google Fonts (fonts.googleapis.com + fonts.gstatic.com), styles
      // inline. CERO scripts permitidos — si el escape falla y alguien
      // inyecta <script>, no corre.
      "Content-Security-Policy": [
        "default-src 'none'",
        "img-src 'self' data: blob:",
        "style-src 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
