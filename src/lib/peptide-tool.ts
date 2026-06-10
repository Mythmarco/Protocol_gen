import { createAdminClient } from "@/utils/supabase/admin";
import type Anthropic from "@anthropic-ai/sdk";

// Cache in-memory para queries del catálogo Peptide. TTL 60s (igual que
// el price-tool). Cada llamada al mismo péptido en la misma generación
// reusa el resultado — antes hacíamos 3 round-trips a Supabase para 3
// péptidos aunque sean idénticos en queries consecutivas. Ahora 1.
// La invalidación es por TTL — Marco edita Supabase y máximo 60s después
// la app refleja el cambio.
const peptideCache = new Map<string, { data: unknown; fetchedAt: number }>();
const LIST_CACHE_KEY = "__LIST__";
const CACHE_TTL_MS = 60 * 1000;

export function invalidatePeptideCache(): void {
  peptideCache.clear();
}

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

  // Cache key normalizado para que "BPC-157" / "BPC 157" / "bpc157" reusen
  // el mismo resultado.
  const cacheKey = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const cached = peptideCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  // Service-role client bypasses RLS so the Stacklabs catalog is always readable.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("Peptide")
    .select("*")
    .ilike("name", `%${input.name}%`)
    .limit(5);

  if (error) return { error: error.message, results: [] };
  const result = { results: data ?? [] };
  peptideCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
  return result;
}

// list_peptides — devuelve solo nombres + tags resumidos de TODO el catálogo.
// Le da al modelo awareness del inventario para responder "¿qué péptidos
// tienes?" sin tener que adivinar nombres, y para sugerir candidatos por
// objetivo. Payload pequeño: hasta ~50 nombres con campos cortos.
export async function executeListPeptidesTool() {
  const cached = peptideCache.get(LIST_CACHE_KEY);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const supabase = createAdminClient();
  // Si en la tabla hay otros campos descriptivos cortos (category, tag,
  // primaryUse, etc.) los inclumos opcionalmente. Para evitar inflar
  // contexto NO traemos description_es/en aquí — para eso ya está
  // get_peptide_info con nombre.
  const { data, error } = await supabase
    .from("Peptide")
    .select("name, category, primaryUse, dosage, frequency")
    .order("name", { ascending: true })
    .limit(100);

  if (error) {
    // Si alguna columna no existe en la tabla, hacemos fallback a solo name
    // para que el tool siempre devuelva algo útil.
    const fallback = await supabase
      .from("Peptide")
      .select("name")
      .order("name", { ascending: true })
      .limit(100);
    if (fallback.error) {
      return { error: fallback.error.message, peptidos: [] };
    }
    const fallbackResult = {
      peptidos: (fallback.data ?? []).map((r) => ({ name: r.name })),
      note: "Catálogo en versión simplificada (sin tags). Usa get_peptide_info para detalles de cualquier péptido.",
    };
    peptideCache.set(LIST_CACHE_KEY, { data: fallbackResult, fetchedAt: Date.now() });
    return fallbackResult;
  }

  const result = {
    peptidos: data ?? [],
    count: (data ?? []).length,
  };
  peptideCache.set(LIST_CACHE_KEY, { data: result, fetchedAt: Date.now() });
  return result;
}
