import OpenAI from "openai";
import { getSession } from "@/lib/session";
import { executePeptideTool, executeListPeptidesTool } from "@/lib/peptide-tool";
import { executePriceTool } from "@/lib/price-tool";
import { executeMemoryTool } from "@/lib/memory-tool";
import { OPENAI_RESPONSES_TOOLS } from "@/lib/openai-tools";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import type { ProtocoloData } from "@/lib/protocol-types";

// Voice-to-reasoning handoff. Called by the Realtime voice agent's
// `handoff_to_reasoning` tool with the structured data gathered from the
// conversation. We then run GPT-5.5 to validate, look up missing prices/info,
// and produce the FULL ProtocoloData JSON. The voice agent receives the
// completed protocol and confirms verbally to the doctor.

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.5";

interface GatheredData {
  // Loose shape — whatever the voice agent collected. The reasoning model fills the gaps.
  paciente?: Record<string, unknown>;
  protocolo?: Record<string, unknown>;
  cotizacion?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  notas_doctor?: string;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY missing" }, { status: 500 });
  }

  const { gathered } = (await req.json()) as { gathered: GatheredData };

  // INSTRUCTIONS constantes (sin ${session.email} ni ${new Date()}) para que
  // OpenAI cachee el prefijo del prompt entre requests (50% descuento input
  // tokens). El contexto runtime se pasa como mensaje al inicio del input.
  const instructions = `# Role
Eres el motor de razonamiento de Peptides4ALL. El médico habló por voz y un asistente conversacional recogió los datos en \`gathered\`. Tu trabajo: tomarlos, validarlos contra el catálogo, llenar huecos con las tools, y producir el ProtocoloData completo via finalize_protocol.

# Principio rector — RESPETAR lo dictado
Lo que viene en \`gathered\` ES lo que el doctor dictó. NUNCA lo "optimices" o cambies a una presentación/unidad estándar que tú creas más eficiente. Tu rol es completar lo faltante y validar precios, no reinterpretar.

# Flujo
1. Por CADA péptido en gathered.peptidos: llama get_peptide_info (para descripción/sinergia) y get_product_price (para precio). Variantes ES/EN si hace falta.
2. Por CADA producto cotizable adicional (agua bacteriostática, etc.): get_product_price.
3. NUNCA cotices jeringas.
4. Construye el ProtocoloData y llama finalize_protocol.

# Reglas duras de fidelidad a los datos dictados
- **Presentación del vial (mg)**: si gathered.peptidos[i].presentacion = "15 mg", úsalo EXACTAMENTE. Cotiza "Retatrutida 15 mg", no 30 mg. Aunque el catálogo solo tenga 30 mg.
- **Unidades de jeringa**: si gathered.peptidos[i].unidades_jeringa = "50", úsalas TAL CUAL en el calendario y en peptidos.indicaciones. NO recalcules.
- **Dosis explícita**: si dosis_descripcion ya viene con valor concreto, NO cambies a una dosis "estándar" del catálogo.
- **Cálculo de unidades SOLO cuando el campo viene vacío**:
  - concentración = vial_mg / 2 mL
  - unidades = (dosis_mg / concentración) × 100. Lógica de redondeo:
    a) Si gathered.peptidos[i].unidades_jeringa ya vino con valor → ÚSALO. El doctor decidió. Punto.
    b) Si no hay valor explícito y el resultado ≤ 50 → redondea al múltiplo de 5 más cercano.
    c) Si el resultado excede 50 (no cabe en jeringa de 0.5 mL): caps a 50 u y AGREGA nota en peptidos[i].indicaciones: "Dosis ajustada a 50 u (capacidad jeringa 0.5 mL) — entrega aprox. X mg de los Y mg solicitados. Considerar jeringa 1 mL si se requiere dosis completa." Nunca sub-doses silenciosamente sin flag.

# Campos del protocolo
- metadata.creado_por: usa el valor que viene en CONTEXTO_RUNTIME al inicio del input.
- metadata.fecha: usa el valor de CONTEXTO_RUNTIME (hoy).
- metadata.idioma = gathered.metadata.idioma
- cotizacion.moneda = gathered.cotizacion.moneda
- explicacion_stack: 1–2 párrafos de SINERGIA entre los péptidos elegidos. NO descripciones individuales recicladas del catálogo.

# cotizacion.nota
Por DEFAULT déjalo como string vacío: "".
NO incluyas explicaciones técnicas ("Public MXN price $X IVA included", "Converted at X.X MXN/USD", "Precio con IVA", "Tipo de cambio"). NO repitas información que ya está en la tabla de productos. Solo escribe algo si el médico te dio una nota específica (ej. "paga en 2 partes").

# Output
LLAMA finalize_protocol con el JSON completo. No respondas con texto suelto.`;

  // Runtime context (cambia cada request → fuera de instructions para no
  // romper el cache). El modelo lo lee al inicio y lo aplica donde el
  // instructions lo refiere.
  const todayIso = new Date().toISOString().slice(0, 10);
  const input: OpenAI.Responses.ResponseInput = [
    {
      role: "user",
      content:
        `### CONTEXTO_RUNTIME\n` +
        `Fecha de hoy: ${todayIso}\n` +
        `Doctor (creado_por): ${session.email}\n`,
    },
    {
      role: "user",
      content:
        "Datos recogidos por el asistente de voz:\n" +
        "```json\n" +
        JSON.stringify(gathered, null, 2) +
        "\n```\n\n" +
        "Valida, completa lo que falte, y llama finalize_protocol.",
    },
  ];

  let finalProtocol: ProtocoloData | null = null;

  // Agentic loop
  for (let turn = 0; turn < 8; turn++) {
    const resp = await client.responses.create({
      model: TEXT_MODEL,
      instructions,
      input,
      tools: OPENAI_RESPONSES_TOOLS,
      tool_choice: "auto",
      // medium en lugar de low: este endpoint corre la composición compleja
      // (validar péptidos, calcular unidades, armar calendario y cotización
      // con precios reales, redactar sinergia). low producía errores
      // sistemáticos en cotizaciones con múltiples péptidos. medium agrega
      // ~2-5s pero la tasa de errores baja notablemente. Chat de texto sigue
      // en low porque sus turnos son simples (Q&A + lookups).
      reasoning: { effort: "medium" },
      text: { verbosity: "low" },
      stream: false,
    });

    const turnToolCalls: Array<{ call_id: string; name: string; arguments: string }> = [];
    for (const item of resp.output) {
      if (item.type === "function_call") {
        turnToolCalls.push({
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments ?? "{}",
        });
      }
    }

    // Push the assistant's function_call items back into input
    for (const tc of turnToolCalls) {
      input.push({
        type: "function_call",
        call_id: tc.call_id,
        name: tc.name,
        arguments: tc.arguments,
      } as OpenAI.Responses.ResponseInputItem);
    }

    // Did the model call finalize?
    const finalCall = turnToolCalls.find((c) => c.name === "finalize_protocol");
    if (finalCall) {
      try {
        finalProtocol = JSON.parse(finalCall.arguments) as ProtocoloData;
        // Server controls metadata (today's date, doctor email) — never trust the model.
        enrichProtocolMetadata(finalProtocol, {
          name: session.name ?? "",
          email: session.email,
        });
        console.log(`[generate-protocol] finalized for ${finalProtocol.paciente?.nombre}`);
      } catch (err) {
        console.error("[generate-protocol] finalize parse failed:", err);
      }
      break;
    }

    // Execute lookups, continue
    const lookups = turnToolCalls.filter((c) => c.name !== "finalize_protocol");
    if (lookups.length === 0) {
      console.warn("[generate-protocol] model stopped without calling finalize_protocol");
      break;
    }

    for (const tc of lookups) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {}

      let result: unknown;
      if (tc.name === "get_peptide_info") {
        result = await executePeptideTool(args as { name: string });
      } else if (tc.name === "list_peptides") {
        result = await executeListPeptidesTool();
      } else if (tc.name === "get_product_price") {
        result = await executePriceTool(args as { product_name: string });
      } else if (tc.name === "search_past_protocols") {
        result = await executeMemoryTool(
          args as { query: string; limit?: number },
          session.id
        );
      } else {
        result = { error: `unknown tool: ${tc.name}` };
      }

      input.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: JSON.stringify(result),
      } as OpenAI.Responses.ResponseInputItem);
    }
  }

  if (!finalProtocol) {
    return Response.json(
      { error: "El modelo no produjo un protocolo final. Reintenta o pide más datos al médico." },
      { status: 500 }
    );
  }

  return Response.json({ protocol: finalProtocol });
}
