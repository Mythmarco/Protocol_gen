// Tool schemas for OpenAI Responses API (text mode with GPT-5.5).
// Top-level format (no `function` wrapper, unlike Chat Completions).
//
// We have 3 lookup tools + 1 finalize tool. The finalize tool's parameters
// ARE the ProtocoloData schema — so when the model calls it, the args are
// guaranteed structurally valid (this is OpenAI's Structured Outputs at the
// tool-call level, more reliable than a free-form JSON in chat text).

import { PROTOCOL_JSON_SCHEMA } from "./protocol-schema";

export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean | null;
}

export const OPENAI_RESPONSES_TOOLS: OpenAITool[] = [
  {
    type: "function",
    name: "get_peptide_info",
    description:
      "Devuelve TODA la información disponible del catálogo Stacklabs sobre un péptido: " +
      "reconstitución, dosis estándar, frecuencia, dosageOptions, descripciones largas ES/EN, " +
      "mecanismo de acción, estructura molecular, vida media, vías, contraindicaciones, sinergias. " +
      "Úsalo para construir protocolos y para responder preguntas generales del médico " +
      "('¿qué hace este péptido?', '¿vida media?', '¿cómo se reconstituye?'). " +
      "Variantes ES/EN: prueba ambos (Retatrutide↔Retatrutida). Si está vacío, dilo — NO inventes datos.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Nombre del péptido. Búsqueda parcial." },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_product_price",
    description:
      "Devuelve precio público MXN CON IVA del catálogo (columna 'Precio al " +
      "Público + IVA'). Usa SIEMPRE el campo precio_mxn_con_iva del resultado. " +
      "NUNCA cotices jeringas.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["product_name"],
      properties: {
        product_name: {
          type: "string",
          description: "Producto con concentración (p.ej. 'Retatrutida 15 mg').",
        },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_past_protocols",
    description:
      "Memoria de protocolos anteriores del médico. Úsalo cuando mencione un " +
      "paciente por nombre o pida continuación. Si vacío, dilo tal cual.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Nombre paciente o palabras clave." },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "finalize_protocol",
    description:
      "Llama esta función SOLO cuando tengas TODOS los datos confirmados con " +
      "el médico. Pasa el JSON completo del protocolo. La app abrirá automáticamente " +
      "la vista previa del PDF. Después di una sola frase corta de confirmación.",
    // The parameters object IS the full ProtocoloData schema. Structured Outputs
    // guarantees this JSON is valid when the model calls the tool.
    parameters: PROTOCOL_JSON_SCHEMA,
    strict: true,
  },
];
