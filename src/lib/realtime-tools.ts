// Tool schemas for OpenAI Realtime API (different shape than Anthropic — top-level
// function definitions, not wrapped). Same 3 lookup tools as the text agent, plus
// a 4th tool the model calls when it has the full protocol ready: `generate_protocol`.
// That last one is handled client-side (not via a server bridge) — when invoked it
// stores the protocol and triggers the preview UI.

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const REALTIME_TOOLS: RealtimeTool[] = [
  {
    type: "function",
    name: "get_peptide_info",
    description:
      "Busca la información base de un péptido en el catálogo de Stacklabs (tabla Peptide). " +
      "Devuelve reconstitución sugerida, dosis estándar, frecuencia, opciones de dosificación " +
      "y descripciones en ES/EN. Úsalo cuando el médico mencione un péptido para no preguntar " +
      "datos que ya están en el catálogo.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Nombre del péptido (Retatrutide/Retatrutida, BPC-157, MOTS-c, CJC-1295, Ipamorelin, etc.). " +
            "Búsqueda parcial.",
        },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "get_product_price",
    description:
      "Devuelve el precio público en MXN CON IVA INCLUIDO de un producto (campo " +
      "'precio_mxn_con_iva' del resultado, columna 'Precio al Público + IVA'). " +
      "Usa para CADA producto que vayas a cotizar (péptidos + agua bacteriostática). " +
      "NUNCA cotices jeringas. Si no encuentra, prueba con el nombre en español " +
      "(Retatrutide → Retatrutida, Ipamorelin → Ipamorelina). " +
      "Si después de probar variantes devuelve vacío, pregúntale el precio al médico.",
    parameters: {
      type: "object",
      properties: {
        product_name: {
          type: "string",
          description: "Nombre del producto (con concentración si aplica: 'Retatrutida 15 mg').",
        },
      },
      required: ["product_name"],
    },
  },
  {
    type: "function",
    name: "search_past_protocols",
    description:
      "Tu memoria de protocolos anteriores del médico. Úsalo cuando mencione un paciente por " +
      "nombre (busca si ya tiene historial), o cuando diga 'el mismo stack que…', 'la dosis que " +
      "le di a…', o pida continuación (mes 2, mes 3). Si devuelve vacío, dilo claramente — NO " +
      "inventes razones (no digas 'error de sesión', 'primera vez', etc.).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Nombre del paciente o palabras clave (p. ej. 'Diego', 'Retatrutide mes 2').",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "generate_protocol",
    description:
      "Llama esta función CUANDO TENGAS TODOS LOS DATOS para generar el protocolo final. " +
      "Pasa el JSON completo con paciente, péptidos, calendario, indicaciones, explicación del " +
      "stack y cotización. La app abrirá automáticamente la vista previa para que el médico la " +
      "revise. Después de llamarla, simplemente di en voz una confirmación corta como 'Listo, " +
      "te muestro la vista previa para que revises'.",
    parameters: {
      type: "object",
      properties: {
        protocol_data: {
          type: "object",
          description:
            "El JSON completo del protocolo. Debe contener: paciente {nombre, peso, estatura, edad, objetivo}, " +
            "protocolo {titulo, duracion_meses, mes_actual, peptidos[], calendario, nota_calendario, " +
            "indicaciones_generales[], explicacion_stack[]}, cotizacion {descripcion, moneda, productos[], " +
            "descuento, envio, total, nota}, metadata {version, fecha, fecha_inicio, fecha_revision, idioma}. " +
            "La fecha es la de hoy. No incluyas 'folio' — se asigna en servidor.",
          properties: {},
        },
      },
      required: ["protocol_data"],
    },
  },
];
