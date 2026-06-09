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
2. Por CADA producto cotizable adicional que mencione el doctor o que el protocolo necesite: get_product_price. Esto INCLUYE **agua bacteriostática** (al menos 1 frasco si hay péptidos a reconstituir), viales adicionales, suplementos del catálogo, etc. NO inventes la regla "solo péptidos" — eso es FALSO.
3. La ÚNICA exclusión absoluta: NUNCA cotices jeringas. Esa es la única regla. Cualquier otro insumo SÍ va.
4. Construye el ProtocoloData y llama finalize_protocol.

# 💰 PRECIOS — REGLAS DURAS (causa de bugs reportados por el doctor)
La cotización del PDF depende 100% de que llames get_product_price para CADA producto y uses el campo \`precio_mxn_con_iva\` del resultado. Reglas:

1. **El campo \`precio_mxn_con_iva\` YA viene como NÚMERO** (ej. \`6960\` — no \`"$6,960"\`, no \`"6960"\`, no \`"$ 6,960 MXN"\`). Úsalo directo en \`cotizacion.productos[].precio_unitario\`. NO lo wrappees en strings, NO lo "limpies".

2. **Cómo construir el query** para get_product_price: usa el nombre + la concentración del vial que el doctor dictó. Ejemplos:
   - "Retatrutida 15 mg" ✓
   - "Tirzepatida 30 mg" ✓
   - "BPC-157 10 mg" ✓ (guiones se normalizan a espacios)
   - "Agua bacteriostática" ✓ (sin concentración cuando el catálogo solo tiene una)

3. **Producto NO encontrado** — la tool devuelve \`results: []\` SIN campo \`error\` (catálogo cargó OK pero no tiene ese SKU): **OMITE el producto de la cotización** Y agrega línea en \`cotizacion.nota\`: "Producto [X] no está en el catálogo; confirmar precio con el médico antes de cobrar." JAMÁS dejes \`precio_unitario: 0\` para un producto que omitiste — directamente no lo incluyas en el array \`cotizacion.productos\`.

4. **Concentración inexistente** — la tool devuelve \`note: "La concentración exacta solicitada NO existe..."\` con \`results\` mostrando las disponibles: el péptido SÍ existe pero NO en la concentración dictada. INCLUYE el producto en \`cotizacion.productos\` con \`precio_unitario: 0\` (caso especial — el doctor necesita ver que falta cotizar) y agrega línea en \`cotizacion.nota\`: "Retatrutida 30 mg no existe en catálogo (disponibles: 15, 20, 50, 60 mg). Confirmar concentración con el médico."

5. **Catálogo caído / Sheets falla** — la tool devuelve un campo \`error\` (no solo \`results: []\` vacío): NO omitas el producto. INCLUYE en \`cotizacion.productos\` con \`precio_unitario: 0\` Y línea explícita en \`cotizacion.nota\`: "Error al cotizar [X] (catálogo no respondió); confirmar precio antes de cobrar." Esto evita que un PDF salga sin avisar al doctor que un producto crítico fue silenciado por una falla técnica.

6. **MXN → USD se convierte EN SERVIDOR, NO en el modelo**: cotiza SIEMPRE con \`precio_mxn_con_iva\` directo (en MXN) en \`cotizacion.productos[].precio_unitario\`. El servidor convierte a USD usando el tipo de cambio configurado en env si \`cotizacion.moneda === "USD"\`. NO multipliques ni dividas precios tú mismo. NO uses tipo de cambio inventado.

7. **JAMÁS \`precio_unitario: 0\` si la tool devolvió un número real**. Solo es válido para los casos de regla 4 (concentración inexistente) y regla 5 (error de catálogo).

# Latencia — TOOLS EN PARALELO (CRÍTICO)
El doctor espera ~20-40 segundos por este endpoint y eso es DEMASIADO. Para bajar latencia: **emite TODAS las tool calls independientes en el MISMO turno**, en un único response. NO las hagas en serie (una por turno).

Ejemplo correcto — turno 1 emite 6 tool calls en paralelo:
- get_peptide_info("Retatrutida"), get_peptide_info("Tirzepatida"), get_peptide_info("Ipamorelin")
- get_product_price("Retatrutida 15mg"), get_product_price("Tirzepatida 30mg"), get_product_price("Agua bacteriostática")

Ejemplo MALO — 6 turnos secuenciales, 5x más lento.

Idealmente: **2 turnos máximo**. Turno 1 = todos los lookups en paralelo. Turno 2 = finalize_protocol con la composición final. No hay razón para más turnos.

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
- peptidos[i].ciclo: usa LO QUE EL DOCTOR DICTÓ ("Mes 1", "8 semanas", "Ciclo de mantenimiento"). Si no dictó nada, usa "Mes {gathered.mes_actual} de {gathered.duracion_meses}". **JAMÁS escribas "Día 1, 3, 5…" en ciclo** — eso ya está en el calendario semanal y es ruido visual.
- indicaciones_generales[0]: SIEMPRE empieza con una línea que diga la duración + revisión, usando duracion_meses/mes_actual. Ej: "Protocolo de 1 mes. Revisión clínica al cierre del mes 1." o "Protocolo de 3 meses — actualmente en mes 2. Revisión al cierre de cada mes."

# 🧮 Campos calculados — fórmulas exactas (Structured Outputs los pide pero NO te dice cómo, y termina poniendo basura)
Estos campos están en el schema como required pero el modelo tiende a inventarlos. USA estas fórmulas literales:

- **cotizacion.total** = sum(productos[i].qty × productos[i].precio_unitario) − cotizacion.descuento + (cotizacion.envio_tipo === "costo" ? cotizacion.envio_monto : 0). Calcula tú el total en MXN antes de mandarlo. El servidor hace la conversión a USD si aplica.
- **cotizacion.descripcion** = "Paquete de {duracion_meses} mes(es) para {paciente.nombre}". Una sola línea.
- **cotizacion.folio** = "" (string vacío). El servidor asigna el folio real al guardar. NUNCA inventes uno.
- **cotizacion.nota** = "" por default. Solo escribe algo si: (a) hay productos omitidos por regla 3, (b) hay concentración inexistente por regla 4, (c) hubo error de catálogo por regla 5, (d) el doctor te dio una nota específica. NO repitas info que ya está en la tabla.
- **metadata.fecha_inicio** = mismo valor que metadata.fecha (hoy en formato YYYY-MM-DD).
- **metadata.fecha_revision** = fecha_inicio + duracion_meses meses, en formato YYYY-MM-DD. Si duracion_meses=3 y hoy es 2026-06-15, fecha_revision = "2026-09-15".
- **metadata.titulo** = "Protocolo de {paciente.nombre} — {paciente.objetivo}". Una sola línea, sin emoji, sin "✓".
- **metadata.version** = "1.0" si es draft nuevo, "2.0" si gathered indica que es continuación.

# 💧 Agua bacteriostática (regla determinista)
Si hay al menos UN péptido a reconstituir en el protocolo, AGREGA un producto "Agua bacteriostática" a la cotización con:
- qty = ceil(N_viales_péptidos × 2 mL / 10 mL) — un frasco de 10 mL alcanza para ~5 viales de péptido (asumiendo 2 mL por reconstitución).
- Mínimo qty = 1 si hay al menos 1 vial de péptido.
- precio_unitario = el que devuelva get_product_price("Agua bacteriostática").

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
  const t0 = Date.now();

  // Agentic loop. Max 5 turns (era 8) — el prompt ahora obliga a tools
  // en paralelo, deberían bastar 2 turnos en el caso típico (lookups +
  // finalize). 5 es el techo defensivo para edge cases con péptidos
  // que requieren lookups extra. Antes el 8 enmascaraba el bug de
  // llamadas seriales — el modelo aprovechaba todos los turnos.
  for (let turn = 0; turn < 5; turn++) {
    const tTurn = Date.now();
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

    // Execute lookups EN PARALELO. Antes era un for/await secuencial
    // que sumaba la latencia de cada tool (peptide ~50ms, price ~200ms
    // por ser HTTP a Google Sheets). Con 6 tools en serie eso suma
    // ~1.5s muerto; con Promise.all baja a ~250ms (max(individuales)).
    const lookups = turnToolCalls.filter((c) => c.name !== "finalize_protocol");
    if (lookups.length === 0) {
      console.warn("[generate-protocol] model stopped without calling finalize_protocol");
      break;
    }

    const results = await Promise.all(
      lookups.map(async (tc) => {
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
        return { tc, result };
      })
    );

    for (const { tc, result } of results) {
      input.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: JSON.stringify(result),
      } as OpenAI.Responses.ResponseInputItem);
    }
    console.log(
      `[generate-protocol] turn ${turn + 1}: ${lookups.length} tools, ${Date.now() - tTurn}ms`
    );
  }

  console.log(`[generate-protocol] total ${Date.now() - t0}ms`);

  if (!finalProtocol) {
    return Response.json(
      { error: "El modelo no produjo un protocolo final. Reintenta o pide más datos al médico." },
      { status: 500 }
    );
  }

  return Response.json({ protocol: finalProtocol });
}
