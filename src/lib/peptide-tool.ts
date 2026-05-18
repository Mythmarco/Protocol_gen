import { createAdminClient } from "@/utils/supabase/admin";
import type Anthropic from "@anthropic-ai/sdk";

// The single Claude tool that lets the model fetch base-protocol info
// from the Stacklabs Peptide table in Supabase.
export const PEPTIDE_TOOL: Anthropic.Tool = {
  name: "get_peptide_info",
  description:
    "Devuelve TODA la información disponible del catálogo Stacklabs sobre un péptido: " +
    "reconstitución sugerida, dosis estándar, frecuencia, opciones de dosificación (dosageOptions), " +
    "descripciones largas en ES/EN, mecanismo de acción, estructura molecular, " +
    "vida media, vías de administración, contraindicaciones, sinergias y cualquier " +
    "otro campo guardado. Úsalo tanto para construir protocolos como para responder " +
    "preguntas generales del médico ('¿qué hace BPC-157?', '¿cuál es la vida media de Tirzepatida?', " +
    "'¿cómo se reconstituye Ipamorelin?'). Si el péptido no existe en el catálogo devuelve un " +
    "array vacío — entonces aclara al médico que no está en catálogo y NO inventes datos.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Nombre del péptido (p. ej. 'Retatrutide', 'BPC-157', 'MOTS-c', " +
          "'CJC-1295', 'Ipamorelin'). Búsqueda case-insensitive parcial.",
      },
    },
    required: ["name"],
  },
};

export async function executePeptideTool(input: { name: string }) {
  if (!input?.name) return { error: "missing peptide name" };

  // Service-role client bypasses RLS so the Stacklabs catalog is always readable.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("Peptide")
    .select("*")
    .ilike("name", `%${input.name}%`)
    .limit(5);

  if (error) return { error: error.message, results: [] };
  return { results: data ?? [] };
}
