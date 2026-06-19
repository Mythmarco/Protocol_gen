import OpenAI from "openai";
import { getSession } from "@/lib/session";
import { executePeptideTool, executeListPeptidesTool } from "@/lib/peptide-tool";
import { executePriceTool } from "@/lib/price-tool";
import { executeMemoryTool } from "@/lib/memory-tool";
import { OPENAI_RESPONSES_TOOLS } from "@/lib/openai-tools";
import { enrichProtocolMetadata } from "@/lib/metadata-enricher";
import { patientHash } from "@/lib/safe-log";
import { newRequestId } from "@/lib/observability";
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
- **cotizacion.skip_fx_conversion** = false por default. true SOLO si \`gathered.notas_doctor\` o el contexto contiene precios EXPLÍCITOS en USD que el doctor dictó (ej. "Reta es $382 USD"). En ese caso pones esos precios EXACTOS, sin convertir, y el servidor NO los toca.
- **peptidos[i].nombre y cotizacion.productos[i].nombre y calendario[i].peptido_label** deben incluir el GRAMAJE del vial: "Retatrutide 30 mg", "NAD+ 1000 mg", "GHK-Cu 50 mg". NUNCA solo "Retatrutide".
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

# 📅 USO DEL CATÁLOGO PARA DOSIS, DÍAS Y FRECUENCIA (CRÍTICO)
get_peptide_info devuelve campos del catálogo Stacklabs con la verdad clínica del laboratorio:
- **dosage / dosage_es** — dosis estándar
- **frequency / frequency_es** — qué tan seguido se aplica
- **cycle / cycle_es** — duración del ciclo (ej. "20 sesiones, repetir cada 6 meses")
- **dosageOptions_es** — array JSON con {amount, frequency, note} — formato más estructurado

REGLAS DURAS (estas son la causa del bug reportado por el doctor — protocolos con rangos inventados):

1. **Dosis**: si el catálogo tiene dosage_es / dosageOptions_es con un valor concreto, USA EXACTAMENTE ese valor en peptidos[i].dosis_descripcion. Ejemplos del catálogo real:
   - Epitalon: dosis = "50 unidades subcutáneas (10 mg)"
   - BPC-157: usa el dosage_es del catálogo
   - JAMÁS inventes rangos como "250-500 mcg" si el catálogo dice "250 mcg/día". El doctor reportó este bug específicamente.

2. **Frecuencia y días**: usa frequency_es del catálogo TAL CUAL. Ejemplos reales:
   - Retatrutida: "Una vez por semana" → escoge VIERNES si el doctor no dictó día
   - BPC-157: usa frequency_es del catálogo
   - Epitalon: "Diario por 10 Días Seguidos" → calendario TODOS los días del Lun a Dom marcados durante 10 días
   - Cerebrolysin: "Cada segundo día" (NO diario) → calendario lunes, miércoles, viernes durante el ciclo

3. **Mapeo de clases de péptidos cuando catálogo NO especifica día concreto**:
   - **GLP-1/GIP semanales** (Retatrutida, Tirzepatida, Semaglutida, Cagrilintida, Cagrilintide+Reta/Tirze): VIERNES por default
   - **GH-secretagogos diarios** (Ipamorelin, CJC-1295, GHRP-6, Tesamorelin): Lunes a Viernes (nocturno típico)
   - **Reparación tisular L-V** (BPC-157, TB-500, PT-141, KPV, LL-37, MOTS-c, GHK-Cu, SS-31, Glow, Klow): Lunes a Viernes (descansa fines)
   - **Ciclo corto intensivo DIARIO** (Epitalon, NAD+, Vilon, Tymalin, Thymosin Alpha 1, DSIP, Glutathione 1500): TODOS los días (L-D) durante el ciclo que diga el catálogo (10 días, 20 días, etc.). Estos NO son "una vez por semana" — son protocolos breves intensivos.
   - **Cada segundo día** (Cerebrolysin): Lun-Mié-Vie semana 1, Mar-Jue-Sáb semana 2, etc. (alterna). En el calendario semanal pon "60 mg IM" en Lun-Mié-Vie por simplicidad — la nota_calendario explica el patrón real.
   - **Nootrópicos orales** (Tesofensine, J-147, BAM-15, NOOPEPT, 5-Amino-1MQ Oral): diario por boca, marca TODOS los días.

4. **El calendario DEBE tener valor concreto por cada día de aplicación**:
   - Retatrutide 1× semana viernes: Lun-Jue="—", Vie="50 u", Sáb-Dom="—"
   - Epitalon 10 días diario: TODOS los días = "50 u" (sí, incluyendo sábado y domingo)
   - BPC-157 L-V: Lun-Vie con dosis del catálogo, Sáb-Dom = "—"

5. **JAMÁS calendario con todos "—" para un péptido activo**. Si tras finalize el calendario está vacío, es BUG y el server lo detecta en log.

6. **nota_calendario** debe mencionar la duración del ciclo si es corto: "Epitalon: protocolo de 10 días consecutivos, repetir 2 veces al año." Sin esto, el doctor cree que es indefinido.

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
  const reqId = newRequestId();
  // Trackeo de queries de precio + RESULTADO MXN del catálogo. Lo usamos
  // para 2 cosas:
  //   (a) Validar que cada producto cotizado pasó por get_product_price
  //       (anti-alucinación, workflow item 6).
  //   (b) SOBRESCRIBIR el precio del modelo con el MXN real del catálogo
  //       antes de enrichear — workflow encontró que el modelo a veces
  //       convertía a USD pese a la regla 6 (cotiza en MXN), y luego
  //       enrichProtocolMetadata convertía OTRA vez → precios divididos
  //       dos veces ($6,960 → $24.08). Esto se acabó.
  const pricedQueries = new Set<string>();
  const pricedCatalog: Array<{ query: string; nombre: string; mxn: number }> = [];
  const normQuery = (q: string) =>
    q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // Agentic loop. Max 5 turns (era 8) — el prompt ahora obliga a tools
  // en paralelo, deberían bastar 2 turnos en el caso típico (lookups +
  // finalize). 5 es el techo defensivo para edge cases con péptidos
  // que requieren lookups extra. Antes el 8 enmascaraba el bug de
  // llamadas seriales — el modelo aprovechaba todos los turnos.
  // Reasoning effort dinámico: medium SOLO si hay 3+ péptidos. Para
  // protocolos simples (1-2 péptidos, caso típico de Marco) low es
  // suficiente y baja la latencia ~5-10s. Marco reportó que generar el
  // protocolo de un solo péptido se sentía lentísimo — innecesario
  // gastar reasoning medium en eso.
  const peptidosCount = Array.isArray(
    (gathered as { peptidos?: unknown[] })?.peptidos
  )
    ? ((gathered as { peptidos: unknown[] }).peptidos.length)
    : 0;
  const effort: "low" | "medium" = peptidosCount >= 3 ? "medium" : "low";
  console.log(`[generate-protocol] reqId=${reqId} peptidos=${peptidosCount} reasoning_effort=${effort}`);

  for (let turn = 0; turn < 5; turn++) {
    const tTurn = Date.now();
    const resp = await client.responses.create({
      model: TEXT_MODEL,
      instructions,
      input,
      tools: OPENAI_RESPONSES_TOOLS,
      tool_choice: "auto",
      reasoning: { effort },
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

    // EJECUTA lookups (no-finalize) ANTES de procesar finalize. El modelo
    // emite frecuentemente get_product_price + finalize en el MISMO turno
    // — antes el finalize se procesaba PRIMERO y pricedCatalog quedaba
    // vacío, por lo que el overwrite de precios no encontraba match y los
    // precios alucinados (ya divididos a USD) llegaban al PDF. Ahora
    // ejecutamos lookups primero, populamos pricedCatalog, y entonces
    // chequeamos finalize con datos reales.
    const lookups = turnToolCalls.filter((c) => c.name !== "finalize_protocol");
    if (lookups.length > 0) {
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
            // También trackea el query para validación contra finalize.
            if (typeof args.product_name === "string") {
              pricedQueries.add(normQuery(args.product_name));
            }
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

      // Populamos pricedCatalog + push outputs al input.
      for (const { tc, result } of results) {
        if (tc.name === "get_product_price") {
          try {
            const args = tc.arguments ? JSON.parse(tc.arguments) : {};
            const query = String(args.product_name ?? "").trim();
            const r = result as { results?: Array<{ producto?: string; precio_mxn_con_iva?: number }> };
            if (Array.isArray(r?.results) && r.results.length > 0) {
              for (const row of r.results) {
                if (typeof row.precio_mxn_con_iva === "number" && row.precio_mxn_con_iva > 0) {
                  pricedCatalog.push({
                    query,
                    nombre: String(row.producto ?? ""),
                    mxn: row.precio_mxn_con_iva,
                  });
                }
              }
            }
          } catch (err) {
            console.warn(`[generate-protocol] could not parse price result:`, err);
          }
        }
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

    // Did the model call finalize? (chequeado DESPUÉS de ejecutar lookups
    // para que pricedCatalog tenga los precios reales del catálogo).
    const finalCall = turnToolCalls.find((c) => c.name === "finalize_protocol");
    if (finalCall) {
      try {
        const candidate = JSON.parse(finalCall.arguments) as ProtocoloData;

        // VALIDACIÓN — cada producto cotizado debe matchear con al menos
        // un get_product_price ejecutado en el historial. Si el modelo
        // intentó alucinar precios sin consultar el catálogo, lo rechazamos
        // y forzamos un turno más con instrucción explícita.
        //
        // EXCEPCIÓN: skip_fx_conversion=true significa que el doctor dio
        // precios MANUALMENTE en el chat. No validamos contra catálogo
        // porque son del doctor por definición — saltarse esta validación.
        const productosCotizados = Array.isArray(candidate.cotizacion?.productos)
          ? candidate.cotizacion.productos
          : [];
        const skipValidation =
          candidate.cotizacion?.skip_fx_conversion === true;
        const unverified: string[] = [];
        if (!skipValidation) for (const p of productosCotizados) {
          const nm = typeof p?.nombre === "string" ? p.nombre : "";
          if (!nm) continue;
          // Acepta si el nombre del producto o cualquier sustring "palabra"
          // matchea con alguna query ejecutada. Tolerante a discrepancias
          // de mayúsculas/concentración (ej. "Retatrutida 15 mg" cotizado,
          // query fue "Retatrutida 15mg" — ambos normalizan igual).
          const normNm = normQuery(nm);
          const words = normNm.split(" ").filter((w) => w.length >= 3);
          const matched = [...pricedQueries].some(
            (q) =>
              q.includes(normNm) ||
              normNm.includes(q) ||
              // Al menos una palabra significativa en común (anti-alucinación
              // débil pero suficiente para detectar "el modelo inventó")
              (words.length > 0 && words.some((w) => q.includes(w)))
          );
          if (!matched && Number(p?.precio_unitario) > 0) {
            unverified.push(nm);
          }
        }

        if (unverified.length > 0) {
          console.warn(
            `[generate-protocol] reqId=${reqId} REJECTED finalize — ${unverified.length} productos sin get_product_price: ${unverified.join(", ")}`
          );
          // Push the finalize_call y un output que le diga al modelo qué hizo mal
          input.push({
            type: "function_call",
            call_id: finalCall.call_id,
            name: finalCall.name,
            arguments: finalCall.arguments,
          } as OpenAI.Responses.ResponseInputItem);
          input.push({
            type: "function_call_output",
            call_id: finalCall.call_id,
            output: JSON.stringify({
              error: "validation_failed",
              reason:
                "Cotizaste productos sin haberlos consultado con get_product_price antes. NO inventes precios. Llama get_product_price para CADA uno y vuelve a finalize.",
              unverified_products: unverified,
            }),
          } as OpenAI.Responses.ResponseInputItem);
          // Continúa al siguiente turno — el modelo debe llamar
          // get_product_price y re-emitir finalize.
          continue;
        }

        // SOBRESCRIBE precios del modelo con MXN reales del catálogo.
        // El modelo a veces convertía a USD pese a la regla 6, y luego
        // enrichProtocolMetadata convertía OTRA vez → precios divididos
        // dos veces ($6,960 → $24.08 en lugar de $409.41). Ahora el
        // servidor pone el precio MXN canónico ANTES de enriquecer.
        //
        // EXCEPCIÓN: si el doctor proporcionó precios MANUALMENTE (flag
        // skip_fx_conversion=true), NO sobrescribimos. Esos precios son
        // del doctor (típicamente USD negociados) y reemplazarlos con
        // MXN del catálogo rompe el flow de edición. enricher también
        // honra el flag y no convierte.
        const userSuppliedPrices =
          candidate.cotizacion?.skip_fx_conversion === true;
        if (!userSuppliedPrices && Array.isArray(candidate.cotizacion?.productos)) {
          const matchPrice = (productoNombre: string): number | null => {
            const target = normQuery(productoNombre);
            if (!target) return null;
            // Match: el query o el nombre catalogo aparece en el otro,
            // O comparten palabras significativas (≥3 chars).
            for (const c of pricedCatalog) {
              const q = normQuery(c.query);
              const n = normQuery(c.nombre);
              if (q === target || n === target) return c.mxn;
              if (target.includes(q) || q.includes(target)) return c.mxn;
              if (target.includes(n) || n.includes(target)) return c.mxn;
            }
            // Fallback fuzzy: si hay al menos 2 palabras significativas en común
            const targetWords = new Set(
              target.split(" ").filter((w) => w.length >= 3)
            );
            for (const c of pricedCatalog) {
              const candidateWords = normQuery(c.nombre + " " + c.query)
                .split(" ")
                .filter((w) => w.length >= 3);
              const common = candidateWords.filter((w) => targetWords.has(w));
              if (common.length >= 2) return c.mxn;
            }
            return null;
          };

          let overwrites = 0;
          const mismatches: string[] = [];
          candidate.cotizacion.productos = candidate.cotizacion.productos.map((p) => {
            const realMxn = matchPrice(String(p?.nombre ?? ""));
            if (realMxn != null && realMxn !== Number(p?.precio_unitario)) {
              overwrites++;
              const oldPrice = Number(p?.precio_unitario) || 0;
              if (Math.abs(oldPrice - realMxn) > 1) {
                mismatches.push(`${p.nombre}: model=${oldPrice} → catalog=${realMxn} MXN`);
              }
              return { ...p, precio_unitario: realMxn };
            }
            return p;
          });
          if (overwrites > 0) {
            console.log(
              `[generate-protocol] reqId=${reqId} overwrote ${overwrites} precio(s) con MXN del catálogo`
            );
            if (mismatches.length > 0) {
              console.warn(`[generate-protocol] reqId=${reqId} price mismatches:\n  ${mismatches.join("\n  ")}`);
            }
          }
          // Recalcular total en MXN con los precios corregidos.
          const productosTotal = candidate.cotizacion.productos.reduce(
            (sum, p) => sum + (Number(p.qty) || 0) * (Number(p.precio_unitario) || 0),
            0
          );
          const envioMonto =
            candidate.cotizacion.envio_tipo === "costo"
              ? Number(candidate.cotizacion.envio_monto) || 0
              : 0;
          const descuento = Number(candidate.cotizacion.descuento) || 0;
          candidate.cotizacion.total = productosTotal - descuento + envioMonto;
        }

        // VALIDACIÓN del calendario: detecta péptidos con TODOS los días
        // en "—" (calendario vacío para ese péptido). Loggea warning para
        // diagnóstico — significa que el modelo no escogió un día default
        // pese a las reglas del prompt. No bloquea (el doctor puede pedir
        // un cambio), pero queda visible en logs para iterar el prompt.
        if (Array.isArray(candidate.protocolo?.calendario)) {
          const DAYS = ["Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado", "Domingo"];
          const peptidosWithoutDays: string[] = [];
          for (const row of candidate.protocolo.calendario) {
            const allEmpty = DAYS.every((d) => {
              const v = (row as unknown as Record<string, unknown>)[d];
              return !v || String(v).trim() === "" || String(v).trim() === "—";
            });
            if (allEmpty) {
              peptidosWithoutDays.push(String((row as { peptido_label?: string }).peptido_label ?? "?"));
            }
          }
          if (peptidosWithoutDays.length > 0) {
            console.warn(
              `[generate-protocol] reqId=${reqId} CALENDARIO BUG — peptidos sin días: ${peptidosWithoutDays.join(", ")}`
            );
          }
        }

        finalProtocol = candidate;
        // Server controls metadata (today's date, doctor email) — never trust the model.
        enrichProtocolMetadata(finalProtocol, {
          name: session.name ?? "",
          email: session.email,
        });
        // No loggeamos el nombre del paciente — hash en su lugar para
        // que Marco pueda correlacionar logs sin que Vercel se convierta
        // en un PHI store (LFPDPPP/HIPAA-equivalent).
        console.log(`[generate-protocol] reqId=${reqId} finalized ${patientHash(finalProtocol.paciente?.nombre)}`);
      } catch (err) {
        console.error(`[generate-protocol] reqId=${reqId} finalize parse failed:`, err);
      }
      break;
    }

    // Si no había lookups Y no hubo finalize, el modelo se rindió.
    if (lookups.length === 0 && !finalCall) {
      console.warn(`[generate-protocol] reqId=${reqId} model stopped without calling finalize_protocol`);
      break;
    }
  }

  console.log(`[generate-protocol] reqId=${reqId} total ${Date.now() - t0}ms`);

  if (!finalProtocol) {
    // Snapshot mínimo para diagnóstico — sin esto Marco no podía saber
    // si el modelo falló por timeout, por validación de precios, por
    // alucinación de schema, etc. Loggeamos resumen NO-PHI (hashes, no
    // nombres). Workflow item 9.
    console.error(
      `[generate-protocol] reqId=${reqId} NO FINALIZE — turns=${5}, ` +
        `priced_queries=${pricedQueries.size}, ` +
        `input_items=${input.length}, ` +
        `elapsed=${Date.now() - t0}ms`
    );
    return Response.json(
      {
        error: "El modelo no produjo un protocolo final. Reintenta o pide más datos al médico.",
        request_id: reqId,
      },
      { status: 500 }
    );
  }

  return Response.json({ protocol: finalProtocol, request_id: reqId });
}
