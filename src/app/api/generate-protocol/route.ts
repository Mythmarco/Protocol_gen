import OpenAI from "openai";
import { getSession } from "@/lib/session";
import { executePeptideTool } from "@/lib/peptide-tool";
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

  const instructions = `Eres el motor de razonamiento de Peptides4ALL. El médico habló por voz y un asistente conversacional recogió los datos. Tu trabajo: tomarlos, validarlos contra el catálogo, llenar huecos con las tools, y producir el ProtocoloData completo via finalize_protocol.

REGLAS:
- Usa get_peptide_info y get_product_price para CADA péptido y producto cotizable
- NUNCA cotices jeringas
- Calcula unidades de jeringa correctamente (vial mg / 2 mL = concentración, dosis_mg / concentración × 100 = unidades, redondear a múltiplo de 5)
- Idioma del protocolo y moneda vienen en gathered.metadata.idioma / gathered.cotizacion.moneda
- metadata.creado_por debe ser exactamente "${session.email}"
- metadata.fecha = ${new Date().toISOString().slice(0, 10)}
- explicacion_stack: 1-2 párrafos de SINERGIA, NO descripciones individuales

REGLA IMPORTANTE PARA cotizacion.nota:
- Por DEFAULT déjalo como string vacío: "".
- NO incluyas explicaciones técnicas tipo "Public MXN price $X IVA included", "Converted at X.X MXN/USD", "Precio público con IVA", "Tipo de cambio", etc.
- NO repitas información que ya está en la tabla de productos (qty, precio, total).
- Solo escribe algo SI el médico te dio una nota específica para esa cotización (ej: "el paciente paga en 2 partes"). Si no, deja vacío.

LLAMA finalize_protocol con el JSON completo cuando termines. No respondas con texto suelto.`;

  const input: OpenAI.Responses.ResponseInput = [
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
      reasoning: { effort: "low" },
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
