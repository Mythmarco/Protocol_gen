import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/utils/supabase/admin";

// AI memory tool: searches the doctor's previously-generated protocols.
// Backed by the `protocolos` table in Supabase. Scoped to the signed-in user
// (creado_por = session.id) so each admin only sees their own history.

export const MEMORY_TOOL: Anthropic.Tool = {
  name: "search_past_protocols",
  description:
    "Busca protocolos que el médico ya ha generado antes para un paciente o " +
    "con un péptido específico. Útil cuando el médico hace referencia a un " +
    "protocolo previo (p.ej. 'el mismo stack que le di a Diego', 'usa la dosis " +
    "de Retatrutide del mes pasado', '¿qué le receté a Mayra?'). " +
    "Devuelve los protocolos más recientes que coincidan con la búsqueda, " +
    "con todos sus datos (péptidos, dosis, cotización, fechas). " +
    "Si no encuentra coincidencias, devuelve un array vacío.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Término de búsqueda: nombre del paciente (preferido) o palabras " +
          "clave del protocolo (p.ej. 'Retatrutide', 'Mes 2 visceral'). " +
          "Búsqueda case-insensitive sobre nombre_paciente + descripcion.",
      },
      limit: {
        type: "number",
        description: "Máximo de resultados a devolver. Default 5, máximo 20.",
      },
    },
    required: ["query"],
  },
};

// PostgREST `.or()` parses commas/parens/colons as filter syntax — un
// término del modelo con esos chars (o un patrón malicioso) podría romper la
// query o ensanchar el matching más allá del usuario actual. Mantenemos solo
// letras/dígitos/espacios/acentos/guiones, que es lo que un nombre de
// paciente o palabra clave clínica realmente necesita para ilike.
function sanitizeSearchQuery(q: string): string {
  return q
    .replace(new RegExp("[^\\p{L}\\p{N}\\s\\-]", "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function executeMemoryTool(
  input: { query: string; limit?: number },
  userId: string
) {
  if (!input?.query) return { error: "missing query", results: [] };

  const q = sanitizeSearchQuery(input.query);
  if (!q) {
    return {
      results: [],
      count: 0,
      note: "La búsqueda quedó vacía después de remover caracteres especiales.",
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("protocolos")
    .select("id, paciente_nombre, descripcion, datos_json, drive_url, fecha_creacion")
    .eq("creado_por", userId)
    .or(`paciente_nombre.ilike.%${q}%,descripcion.ilike.%${q}%`)
    .order("fecha_creacion", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[memory] Supabase query error:", error);
    return {
      error: error.message,
      results: [],
      note: "Hubo un error técnico al consultar la base de datos. No es un problema de permisos del usuario.",
    };
  }

  const results = (data ?? []).map((r) => ({
    id: r.id,
    paciente: r.paciente_nombre,
    descripcion: r.descripcion,
    fecha: r.fecha_creacion,
    drive_url: r.drive_url,
    protocolo: r.datos_json,
  }));

  if (results.length === 0) {
    return {
      results: [],
      count: 0,
      note: "No hay protocolos guardados que coincidan con esta búsqueda. Esto NO es un error — simplemente la búsqueda no encontró resultados. Puede ser un paciente nuevo, o que aún no se haya generado ningún protocolo para este usuario.",
    };
  }

  return { results, count: results.length };
}
