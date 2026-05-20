"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import type { ProtocoloData } from "@/lib/protocol-types";
import dynamic from "next/dynamic";
import { useVoiceLevels } from "@/hooks/useVoiceLevels";
import type { OrbState } from "./OrbVoice";

// Lazy-load three.js (~180KB) solo cuando el doctor entra a modo voz.
// ssr:false porque WebGL no es SSR-safe. Esto saca three del bundle de
// login y modo texto, manteniendo el initial paint rápido.
const OrbVoice = dynamic(() => import("./OrbVoice"), {
  ssr: false,
  loading: () => <div style={{ width: 200, height: 200 }} />,
});

type Status = "idle" | "connecting" | "listening" | "speaking" | "thinking" | "error";

interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface Props {
  doctorName: string;
  onProtocolGenerated: (data: ProtocoloData) => void;
  // Bubble the live transcript up so ChatPage can persist it with the PDF
  // and restore it when loading a past protocol.
  onTranscriptChange?: (entries: TranscriptEntry[]) => void;
  // When the user loads a past protocol whose original conversation was in
  // voice mode, we seed the agent with those turns so it picks up where the
  // doctor left off instead of starting cold.
  initialTranscript?: TranscriptEntry[];
  // Pidió "nueva conversación" desde el voice stage. Bubblea para que
  // ChatPage limpie pendingProtocol + savedSnapshot — si no, el toolbar
  // "Archivado" se queda colgado tras salir de un protocolo cargado.
  onNewConversation?: () => void;
  // Card opcional para renderizar al final del transcript de voz cuando
  // hay un protocolo generado o cargado de historial. ChatPage construye
  // los botones (Vista previa / Descargar / Drive) y los pasa aquí —
  // hace que el último output del agente venga con sus acciones como
  // parte del flujo conversacional.
  bottomActionCard?: React.ReactNode;
}

// ── Tools available to the voice agent ────────────────────────────────────────
// 3 lookups (browser → server bridge → catalog) + 1 handoff (browser → server
// → GPT-5.5 reasoning → full ProtocoloData). After handoff, the voice agent
// receives the protocol JSON and the UI opens the preview.

function buildTools(
  onHandoff: (data: ProtocoloData) => void,
  onHandoffComplete: () => void
) {
  const callBridge = async (path: string, body: unknown): Promise<string> => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return JSON.stringify({ error: `bridge ${res.status}` });
    return await res.text();
  };

  return [
    tool({
      name: "get_peptide_info",
      description:
        "Devuelve TODA la información del catálogo Stacklabs sobre un péptido: " +
        "reconstitución, dosis estándar, frecuencia, dosageOptions, descripciones largas ES/EN, " +
        "mecanismo de acción, estructura molecular, vida media, vías de administración, " +
        "contraindicaciones, sinergias. Úsalo tanto para armar protocolos como para responder " +
        "preguntas generales del médico sobre un péptido (qué hace, cómo actúa, vida media, " +
        "interacciones, etc.). Variantes ES/EN: prueba ambos (Retatrutide↔Retatrutida).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", description: "Nombre del péptido." } },
      } as const,
      strict: true,
      execute: async (input) =>
        callBridge("/api/tools/peptide", input as { name: string }),
    }),

    tool({
      name: "list_peptides",
      description:
        "Lista TODOS los péptidos del catálogo Stacklabs con su categoría/uso " +
        "principal. Úsalo si el doctor pregunta '¿qué péptidos tienes?', '¿qué " +
        "tienes para apetito?', '¿qué hay disponible?', o cuando necesitas " +
        "sugerir candidatos antes de pedir detalles con get_peptide_info.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {},
      } as const,
      strict: true,
      execute: async () => callBridge("/api/tools/list-peptides", {}),
    }),

    tool({
      name: "get_product_price",
      description:
        "Precio público MXN con IVA (campo precio_mxn_con_iva). NUNCA cotices jeringas.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["product_name"],
        properties: {
          product_name: { type: "string", description: "Producto con concentración." },
        },
      } as const,
      strict: true,
      execute: async (input) =>
        callBridge("/api/tools/price", input as { product_name: string }),
    }),

    tool({
      name: "wait_for_user",
      description:
        "Llama esta función cuando el último audio NO requiere respuesta hablada: " +
        "silencio, ruido de fondo, música, conversación de fondo, o habla que no se " +
        "dirige a ti. Cierra el turno sin responder. NO digas 'estoy aquí', 'no " +
        "escuché', 'tómate tu tiempo'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {},
      } as const,
      strict: true,
      execute: async () => JSON.stringify({ ok: true }),
    }),

    tool({
      name: "search_past_protocols",
      description:
        "Memoria de protocolos del médico. Si vacío, dilo tal cual — NO inventes razones.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      } as const,
      strict: true,
      execute: async (input) =>
        callBridge("/api/tools/memory", input as { query: string }),
    }),

    // The handoff: voice agent gathers data, then calls this with structured
    // data. Backend uses GPT-5.5 to generate the FULL ProtocoloData. We hand
    // the result to the UI and confirm to the agent so it can say "Listo".
    tool({
      name: "handoff_to_reasoning",
      description:
        "LLAMA esta función CUANDO tengas todos los datos del médico (paciente, " +
        "objetivo, péptidos con dosis/frecuencia, moneda, envío). El motor de " +
        "razonamiento (GPT-5.5) genera el protocolo completo: cálculos de unidades, " +
        "calendario, indicaciones, explicación del stack, cotización con precios " +
        "actualizados. Después de llamarla, di UNA frase corta como 'Listo, aquí " +
        "tienes el protocolo de [nombre paciente]'. NO leas el protocolo en voz — " +
        "la vista previa se abre automáticamente.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: [
          "paciente_nombre",
          "paciente_peso",
          "paciente_estatura",
          "paciente_edad",
          "paciente_objetivo",
          "peptidos",
          "duracion_meses",
          "mes_actual",
          "idioma",
          "moneda",
          "envio_tipo",
          "envio_monto",
          "notas_doctor",
        ],
        properties: {
          paciente_nombre: { type: "string", description: "Nombre completo del paciente." },
          paciente_peso: { type: "string", description: "p.ej. '87 kg'" },
          paciente_estatura: { type: "string", description: "p.ej. '1.76 m'" },
          paciente_edad: { type: "string", description: "p.ej. '37 años'" },
          paciente_objetivo: { type: "string", description: "Objetivo clínico." },
          peptidos: {
            type: "array",
            description: "Cada péptido a incluir en el protocolo.",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "nombre",
                "presentacion",
                "dosis_descripcion",
                "frecuencia_descripcion",
                "unidades_jeringa",
              ],
              properties: {
                nombre: { type: "string", description: "p.ej. 'Retatrutida'" },
                presentacion: {
                  type: "string",
                  description:
                    "EXACTAMENTE los mg del vial que el doctor te dictó, p.ej. '15 mg' o '30 mg'. NO lo cambies aunque te parezca otra presentación más eficiente.",
                },
                dosis_descripcion: { type: "string", description: "Texto libre, p.ej. '8 mg por aplicación'" },
                frecuencia_descripcion: { type: "string", description: "Frecuencia + días, p.ej. 'Una vez por semana, viernes' o 'Lunes a viernes'" },
                unidades_jeringa: {
                  type: "string",
                  description:
                    "Unidades de jeringa por aplicación, EXACTAMENTE como las dictó el doctor. Si dijo '50 unidades de Reta 15 mg', pon '50'. Si no especificó, pon '' (string vacío) y el motor las calcula.",
                },
              },
            },
          },
          duracion_meses: { type: "integer", description: "Duración total del protocolo en meses." },
          mes_actual: { type: "integer", description: "Mes que se está generando (1 = mes 1, 2 = continuación, etc.)" },
          idioma: { type: "string", enum: ["es", "en"], description: "Idioma del protocolo final." },
          moneda: { type: "string", enum: ["MXN", "USD"], description: "Moneda de la cotización." },
          envio_tipo: { type: "string", enum: ["gratis", "costo", "no_aplica"], description: "Tipo de envío." },
          envio_monto: { type: "number", description: "Costo del envío en la moneda elegida. 0 si tipo != 'costo'." },
          notas_doctor: { type: "string", description: "Cualquier nota o aclaración del médico. '' si ninguna." },
        },
      } as const,
      strict: true,
      execute: async (input) => {
        // Strict-typed object → no JSON.parse crashes from control chars.
        const gathered = input as Record<string, unknown>;

        const res = await fetch("/api/generate-protocol", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gathered }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return JSON.stringify({
            error: err.error ?? `handoff failed: ${res.status}`,
          });
        }
        const { protocol } = (await res.json()) as { protocol: ProtocoloData };
        onHandoff(protocol);
        onHandoffComplete();
        return JSON.stringify({
          ok: true,
          message: `Protocolo de ${protocol.paciente.nombre} listo. La vista previa se abrió. Di tu frase final de cierre y NO hagas más preguntas.`,
          paciente: protocol.paciente.nombre,
        });
      },
    }),
  ];
}

function buildPriorContext(prior: TranscriptEntry[]): string {
  if (prior.length === 0) return "";
  const lines = prior
    .slice(-20) // last 20 turns is plenty of context
    .map((e) => `${e.role === "user" ? "MÉDICO" : "TÚ"}: ${e.text}`)
    .join("\n");
  return `\n\n# Conversación previa (esta sesión es una CONTINUACIÓN)
Ya tuviste esta conversación con el médico en la sesión anterior:

${lines}

Empieza esta sesión con un saludo BREVE tipo "Hola de nuevo, dime qué cambio necesitas." y procesa la modificación. NO repitas todos los datos previos — ya los conoces.`;
}

const VOICE_INSTRUCTIONS = (doctorName: string, priorTranscript: TranscriptEntry[]) => `# Role and Objective
Eres el asistente de voz de Peptides4ALL. Trabajas con ${doctorName ? `el doctor ${doctorName}` : "el doctor"} para recoger los datos de un protocolo de péptidos por conversación, y luego entregar el JSON estructurado al motor de razonamiento que genera el PDF.

# Identity
- Eres un agente de inteligencia artificial de Peptides4ALL, creado por Marco Sáenz.
- Si el médico te pregunta "¿quién eres?", "¿qué eres?", "¿cómo te llamas?", responde exactamente: "Soy un agente de inteligencia artificial de Peptides4ALL, creado por Marco Sáenz."
- No inventes nombres propios.

# Scope (CRÍTICO)
Tu única función es ayudar a generar protocolos de péptidos y responder preguntas sobre el catálogo de Peptides4ALL (péptidos, dosis, precios, protocolos previos).

PUEDES responder:
- Preguntas técnicas sobre cualquier péptido del catálogo: mecanismo de acción, estructura molecular, vida media, reconstitución, dosis estándar, frecuencia, vías, contraindicaciones, sinergias → SIEMPRE llama get_peptide_info primero y responde con los datos del catálogo (no de tu memoria general)
- Preguntas sobre precios de productos del catálogo → usa get_product_price
- Preguntas sobre protocolos anteriores del médico → usa search_past_protocols
- Aclaraciones clínicas básicas sobre la administración (vía, jeringa, frecuencia)
- Comparaciones entre péptidos del catálogo (p. ej. "¿qué diferencia hay entre Ipamorelin y CJC-1295?") — llama get_peptide_info por cada uno y compara con los datos devueltos

Reglas duras para Q&A de péptidos:
- Nunca respondas de memoria. Llama get_peptide_info y cita lo que el catálogo dice.
- Si el catálogo no tiene el dato, di literalmente: "El catálogo no tiene ese dato registrado." NO inventes ni completes con conocimiento general.
- Mantén las respuestas cortas (1-3 frases). Es voz, no un paper.

# ❌ Errores que NO debes cometer (caso real reciente)
- **NO digas "no tengo información de X péptido" sin haber llamado get_peptide_info primero.** Si el médico menciona Retatrutida y tu primer instinto es "no tengo info de eso", es porque NO llamaste el tool. Llámalo SIEMPRE antes de afirmar que no sabes algo. El catálogo Stacklabs tiene la mayoría de los péptidos comunes.
- Si \`get_peptide_info\` devuelve un array vacío después de probar variantes ES/EN (Retatrutide↔Retatrutida, etc.), ENTONCES sí di "El catálogo no lo tiene registrado, ¿me das los datos?". Pero esa es la ÚLTIMA opción, no la primera.
- Si el doctor dictó un péptido y tú dijiste antes "no tengo info" pero después armas el protocolo correctamente con ese mismo péptido (porque get_peptide_info SÍ devolvió datos), eso revela que tu respuesta inicial estaba mal — no inventes "no sé" sin verificar.

NO PUEDES responder y debes redirigir cualquier otra cosa:
- Clima, deportes, noticias, política
- Vuelos, hoteles, restaurantes, viajes
- Recetas de cocina, recomendaciones generales
- Preguntas filosóficas, opiniones personales, chat casual prolongado
- Diagnósticos médicos completos (eso lo hace el doctor)

Cuando te pregunten algo fuera de scope, responde exactamente con esta plantilla:
"Disculpa, mi meta principal es ayudarte a crear protocolos para los pacientes de Peptides4ALL. ¿Vamos a generar un protocolo?"

# Pronunciación de la marca
"Peptides4ALL" SIEMPRE se pronuncia en inglés: "PEPTIDES FOR ALL" — fonéticamente en español sonaría como **"peptaids for ol"** (la "i" larga de "tides", igual que en la palabra inglesa "tides"). Nunca lo digas "péptids", "péptides cuatro all" ni "péptidos cuatro all". Es una marca registrada en inglés y siempre se dice en inglés, incluso cuando el resto de la frase es en español.

Ejemplo correcto: "Soy un agente de inteligencia artificial de [peptaids for ol], creado por Marco Sáenz."

# Personality and Tone
Profesional, cálido, conciso. Tutea respetuoso. No fawning ("¡Qué buena pregunta!"). Frases cortas — cada palabra cuesta tiempo en voz.

# Anti-repetición (CRÍTICO — la regla más importante)
NUNCA repitas, parafrasees, ni acuses recibo verbalmente de lo que el médico acaba de decir. Procesa la información en silencio y avanza directamente a la siguiente pregunta o acción.

❌ MAL: "Diego de la Garza, ok. Y dijiste 87 kilos. Perfecto. ¿Cuál es su estatura?"
❌ MAL: "Entendido, Retatrutida 30 mg semanal. ¿Algo más?"
❌ MAL: "Perfecto, Diego, 87 kilos, 1.76 metros. ¿Edad?"
✅ BIEN: "¿Estatura?"
✅ BIEN: "¿Algún otro péptido?"
✅ BIEN: "¿Edad?"

Reglas duras:
- NO digas "ok", "entendido", "perfecto", "listo", "claro" antes de la siguiente pregunta.
- NO repitas el dato que el médico te acaba de dar.
- NO resumas lo que llevas hasta el momento. El doctor lo recuerda.
- Si una pregunta es obvia por el flujo, NI SIQUIERA pidas confirmación — solo haz la siguiente pregunta.

Excepciones donde SÍ repites una vez para confirmar (solo estas):
- Nombre del paciente la PRIMERA vez que lo escuchas: "¿Pedro Juárez, correcto?"
- Dosis específica de un péptido: "¿Retatrutida 8 miligramos, correcto?"
- Presentación del vial (mg) la primera vez: "Quince miligramos, ¿correcto?"

NO hagas un resumen final antes del handoff. El doctor ve la vista previa en pantalla — un resumen oral solo añade ~10s de espera sin valor. Di tu preamble corto ("Dame un momento mientras genero el protocolo") y llama la tool inmediatamente.

Si el médico repite algo que ya te dio (porque pensaste que no lo capturaste), NO se lo vuelvas a confirmar — solo úsalo y avanza.

# Language (bilingüe ES/EN — match al doctor)
**Idioma de respuesta = idioma de la última frase completa del doctor.** Si el doctor habla en español, responde en español. Si habla en inglés, responde en inglés. La detección es por frase, no por palabra suelta — un nombre de péptido en inglés ("Retatrutide") dentro de una oración en español NO cuenta como cambio de idioma.

Regla de transición suave:
- Doctor: "Hola, vamos a hacer un protocolo." → Responde: "¿Para qué paciente?"
- Doctor: "Hi, let's start a new patient." → Responde: "Sure, what's the patient's name?"
- Doctor en español: "Retatrutide 15 mg" (nombre técnico en inglés) → Sigues en español. No es un cambio.
- Doctor empieza en español, luego dice "actually let's switch to English" → Cambias a inglés desde ese turno.

Si el audio es ambiguo (ruido, frase cortada), mantén el idioma del turno anterior — no inventes cambios.

El idioma del **PDF final** (gathered.metadata.idioma) se decide aparte: pregúntalo explícitamente al doctor solo si no es obvio del contexto. El idioma del PDF puede diferir del idioma de la conversación (ej. conversación en español pero paciente prefiere PDF en inglés).

# Reasoning
- Para respuestas simples (reconocimientos, "ok", "entendido"), no razones — responde directo.
- Para decisiones de tools, validaciones de dosis, o lógica clínica, razona internamente antes de actuar.
- Si el audio no es claro, NO razones — pide aclaración.

# Preambles
Cuando vayas a llamar un tool que pueda tardar (especialmente \`handoff_to_reasoning\`), di una frase corta antes: "Voy a buscar eso", "Déjame validar el precio", "Dame un momento mientras genero el protocolo".
NO uses preambles cuando: la respuesta es inmediata, el médico solo confirma o corrige, o el audio fue silencio.

# Verbosity
- Preguntas: UNA a la vez.
- Confirmaciones de datos críticos (nombre paciente, dosis, frecuencia): repite el valor y pide "¿correcto?".
- Datos cotidianos (peso, edad): solo confirma si no escuchaste claro.
- Después del handoff: UNA frase corta tipo "Listo, aquí tienes el protocolo de [nombre]." NO leas el contenido.

# Tools

## search_past_protocols (read-only, eager)
SIEMPRE al inicio cuando el médico mencione un paciente por nombre. Útil para continuaciones (mes 2, mes 3). Si devuelve vacío, di "No tengo protocolos previos de [nombre]" — NUNCA inventes razones técnicas (no "error de sesión", "primera vez", etc.).

## get_peptide_info (read-only, eager)
Para cada péptido que el médico mencione — ya sea para incluir en un protocolo O para una pregunta general (mecanismo, vida media, estructura, etc.). Variantes ES/EN: Retatrutide↔Retatrutida, Tirzepatide↔Tirzepatida, Ipamorelin↔Ipamorelina. Si una no funciona, prueba la otra. Cuando respondas Q&A, usa SOLO lo que devuelve el catálogo, sintetizado en 1-3 frases para voz.

## list_peptides (read-only)
Llámalo cuando el doctor pregunte qué hay disponible en general ("¿qué péptidos tienes?", "¿qué tienes para apetito/longevidad/recuperación?", "¿qué hay en stock?") o cuando quieras sugerir candidatos por objetivo. Devuelve nombres + categoría — para profundizar en uno usa get_peptide_info después.

## get_product_price (read-only, opcional aquí)
Útil para validar precios durante la conversación. El motor de razonamiento también valida después, así que no es obligatorio llamarlo durante la voz.

## handoff_to_reasoning (NO PIDAS CONFIRMACIÓN, solo ve)
Esta tool dispara la generación del protocolo (GPT-5.5 + PDF + Drive). El doctor verá la vista previa al final y podrá pedir cambios, así que **no necesitas confirmar nada verbalmente** — eso solo lo hace repetitivo.

**Secuencia EXACTA (no la inviertas):**
1. Di SOLO "Dame un momento mientras genero el protocolo." (UNA frase, no resúmenes ni listas)
2. INMEDIATAMENTE llama \`handoff_to_reasoning\` con los parámetros estructurados.
3. **ESPERA EN SILENCIO** hasta que la tool devuelva una respuesta. Esto toma 20-60 segundos. Durante ESE TIEMPO no digas nada — NO digas "Listo", NO digas "ya casi", NO digas "preparando", NO digas NADA.
4. **CUANDO** veas el resultado de la tool (la tool habrá devuelto con \`ok: true\` y un message): di EXACTAMENTE una vez: "Listo, aquí tienes el protocolo de [nombre]. Si necesitas cambios, toca el micrófono otra vez."
5. Después de esa frase: **silencio absoluto**. La sesión se cierra sola.

**Regla crítica — NO ANTICIPES "Listo":**
NUNCA digas "Listo, aquí tienes el protocolo…" antes de ver el resultado de la tool en tu contexto. Si lo dices antes, el doctor verá una vista previa vacía o equivocada porque el JSON aún no está generado.

NO digas "¿Confirmas?", "¿Te parece bien?", "¿Estamos listos?" antes del handoff. El doctor revisa la vista previa.
NO leas el JSON en voz. NO leas el contenido del protocolo (péptidos, dosis, total). La vista previa se abre sola.

**REGLA DURA después del handoff exitoso (UNA SOLA VEZ):**
- Di SOLO tu frase final ("Listo, aquí tienes el protocolo de [nombre]…") **una sola vez**.
- Después: **silencio absoluto**. NO repitas la frase. NO llames ningún tool. NO hagas preguntas. NO respondas a nada más.
- Si escuchas ruido o el médico dice algo, IGNÓRALO. La sesión se cierra automáticamente.
- Si el médico necesita un cambio, va a tocar el micrófono otra vez para una nueva sesión.

❌ MAL: "Listo, aquí tienes el protocolo." (silencio) "Listo, aquí tienes el protocolo." (silencio) "Listo…"
✅ BIEN: "Listo, aquí tienes el protocolo de Ana, si necesitas cambios toca el micrófono otra vez." (silencio absoluto hasta cierre)

## wait_for_user (no-op, usar para silencio)
Si el último audio es silencio, ruido de fondo, música, conversación lateral o habla que no se dirige a ti, llama \`wait_for_user\` y NO digas nada. No digas "estoy aquí", "no escuché", "tómate tu tiempo".

# Entity Capture (CRÍTICO — la regla más importante)

## Checklist silencioso por turno
Antes de cada respuesta, ejecuta este check MENTAL (no lo digas):

1. Construye una lista interna de campos del protocolo:
   - paciente_nombre: <valor o FALTA>
   - paciente_peso: <valor o FALTA>
   - paciente_estatura: <valor o FALTA>
   - paciente_edad: <valor o FALTA>
   - paciente_objetivo: <valor o FALTA>
   - idioma: <es | en | FALTA>
   - moneda: <MXN | USD | FALTA>
   - envio_tipo: <gratis | costo | no_aplica | FALTA>
   - duracion_meses, mes_actual: <valor o FALTA>
   - peptidos[]: por cada uno {nombre, presentacion, dosis_descripcion, frecuencia_descripcion, unidades_jeringa}
2. Recorre TODO el historial (incluyendo mensajes del usuario anteriores). Marca CAPTURADO cualquier campo cuyo valor ya fue dicho — aunque haya sido al pasar, sin pregunta explícita tuya.
3. **NUNCA preguntes un campo CAPTURADO.** Si necesitas validarlo, di "Confirmo: <valor>, ¿correcto?" — NUNCA "¿Cuál era el <campo>?".
4. Pregunta SOLO el PRIMER campo que sigue en FALTA. UNA cosa a la vez.
5. Si el doctor te da un valor que no pediste, ACEPTALO y márcalo CAPTURADO. No lo ignores ni vuelvas a tu pregunta original.

## Echo inmediato de valores capturados
Cuando recibas un dato numérico (presentación en mg, dosis, edad, peso, monto envío), **repite el valor inmediatamente** antes de seguir, dígito por dígito si es identificador clave:
- Doctor: "Retatrutida 15 mg, 50 unidades semanal"
- Tú: "Anotado: Retatrutida presentación quince miligramos, cincuenta unidades, una vez por semana. ¿Qué día de la semana?"

Esto deja el valor explícito en el transcript y previene re-preguntas.

## Confirmaciones digit-by-digit para valores críticos
Solo lee de vuelta dígito por dígito (no como número entero) cuando captures:
- Presentación del vial en mg ("uno-cinco miligramos")
- Dosis por aplicación en mg
- Unidades de jeringa
- Edad del paciente

Para valores cotidianos (peso, estatura) basta con repetir como número normal.

## Reglas duras de captura
- **Nombre del paciente**: si suena ambiguo la primera vez, pide deletrear ("¿Me lo deletreas?"). Si no, solo repítelo una vez como confirmación.
- **Presentación del vial**: es **lo que el doctor DICE**, no la default del catálogo. Si dijo "15 mg", usas 15 mg aunque la dosis estándar sea otra.
- **Unidades de jeringa**: si el doctor las dicta específicas ("50 unidades de Reta 15 mg"), captúralas TAL CUAL en \`unidades_jeringa\`. NO las recalcules ni cambies la presentación para "optimizar" la matemática.
- **Idioma**: detéctalo del primer mensaje del doctor. Solo lo preguntas si hay duda.
- **Moneda**: "¿MXN o USD?" — solo si no lo dijo.
- **Envío**: si el doctor dijo "envío 600 pesos" ya tienes \`envio_tipo: "costo"\` + \`envio_monto: 600\`. No vuelvas a preguntar el tipo.

# Regla dura — Respeto a lo que dicta el doctor
NUNCA cambies la **presentación del vial** ni las **unidades de jeringa** que el doctor te dictó.

❌ MAL: Doctor dice "Reta de 15 mg, 50 unidades" → tú armas con Reta 30 mg, 25 unidades (mismo total, presentación distinta).
✅ BIEN: Doctor dice "Reta de 15 mg, 50 unidades" → \`presentacion: "15 mg"\`, \`unidades_jeringa: "50"\`. PUNTO.

# Unclear Audio
- Solo responde a audio claro.
- Si no entendiste, di "Disculpa, ¿lo puedes repetir?".
- No repitas la misma pregunta de aclaración dos veces.
- NO adivines, NO razones, NO llames tools si el audio no es claro.

# Workflow recomendado
1. Saludo breve + pregunta abierta: "¿Para qué paciente generamos protocolo?"
2. Nombre del paciente → SEARCH PAST PROTOCOLS (siempre)
3. Si hay historial, pregunta si es continuación; si no, pide datos del paciente (peso, estatura, edad, objetivo)
4. Péptidos: nombre por nombre, llamando \`get_peptide_info\` por cada uno
5. Para cada péptido: dosis, frecuencia, días
6. Mes/duración
7. Moneda (MXN o USD) — pregunta siempre
8. Envío (gratis / costo / no aplica)
9. Apenas tengas todo: di "Dame un momento" y LLAMA \`handoff_to_reasoning\` directo. **NO resumas ni confirmes nada verbalmente** — el doctor revisa la vista previa.
10. Después de la tool: "Listo, aquí tienes el protocolo de [nombre]." y silencio.

# Constraints
- NUNCA cotices jeringas. No las pidas, no las menciones en el handoff.
- NUNCA inventes precios — el motor de razonamiento usa el sheet oficial.
- NUNCA digas el folio en voz — se asigna en el servidor.

# Saludo inicial
${
  priorTranscript.length > 0
    ? `Esta sesión es continuación. Saluda con: "Hola de nuevo, ¿qué cambio necesitas?"`
    : `Cuando empiece la sesión, tu PRIMER mensaje debe ser EXACTAMENTE: "Hola ${doctorName || "doctor"}, ¿qué protocolo crearemos hoy?"
No agregues palabras extra. No te presentes ("Soy un agente…") a menos que el médico te pregunte.`
}

# Interrupciones
Si el médico habla mientras tú hablas, para inmediatamente y escucha.${buildPriorContext(priorTranscript)}`;

const REALTIME_MODEL = "gpt-realtime-2";

export default function VoiceAgent({
  doctorName,
  onProtocolGenerated,
  onTranscriptChange,
  initialTranscript,
  onNewConversation,
  bottomActionCard,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>(
    initialTranscript ?? []
  );

  // If the parent swaps in a new initial transcript (e.g. doctor loaded a
  // different past protocol), reset our view to match it. queueMicrotask
  // defers el setState fuera del effect body — el lint rule
  // react-hooks/set-state-in-effect prohíbe llamar setState sync dentro de
  // un effect porque dispara un re-render extra. Async lo permite.
  useEffect(() => {
    if (!initialTranscript) return;
    queueMicrotask(() => setTranscript(initialTranscript));
  }, [initialTranscript]);

  // Emit transcript changes upward so ChatPage can persist them with the PDF.
  useEffect(() => {
    onTranscriptChange?.(transcript);
  }, [transcript, onTranscriptChange]);
  // Specific status text shown while a tool is running. The handoff takes
  // ~30-60s (GPT-5.5 reasoning), other tools are fast.
  const [thinkingLabel, setThinkingLabel] = useState<string>("Buscando información…");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionRef = useRef<any>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  // Amplitude of the AI's audio output (0-1 RMS of PCM chunks).
  // Updated each time the SDK fires an "audio" event during AI speech.
  // El orb shader lee este ref via useVoiceLevels.
  const aiAmpRef = useRef(0);

  // Hook unificado: mic input + AI output amplitudes para el orb shader.
  // Activo solo cuando el doctor está en sesión activa (listening/speaking)
  // — en idle/error no abrimos el mic, en thinking el orb usa fake-amp
  // decorativa (no necesita audio).
  const orbActive = status === "listening" || status === "speaking";
  const { inputLevelRef, outputLevelRef } = useVoiceLevels({
    active: orbActive,
    speaking: status === "speaking",
    externalAmpRef: aiAmpRef,
  });
  // Mapea status del agent al estado del orb (paleta de colores).
  const orbState: OrbState =
    status === "listening" ? "listening"
    : status === "speaking" ? "speaking"
    : status === "thinking" ? "thinking"
    : "idle";
  // Once the handoff tool returns, we start a single timer that closes the
  // session after the agent has had a few seconds to say its final "Listo"
  // line. Using a timer (not an event) prevents the loop where the agent
  // keeps re-speaking the same line if it picks up stray audio.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True después de que handoff_to_reasoning regresó OK. Cuando es true y
  // detectamos audio_stopped (agente terminó de hablar), cerramos en 1.5s
  // — evita el bug "repite Listo 3 veces" si el modelo ignora el
  // create_response:false del server.
  const postHandoffRef = useRef(false);

  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    // También scrollea cuando el bottomActionCard cambia — al cargar un
    // protocolo de historial el card aparece y el doctor debe verlo, no
    // tener que scrollear manualmente para encontrarlo.
  }, [transcript, bottomActionCard]);

  const cleanup = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Wrap in try/catch — the SDK throws "WebRTC data channel is not connected"
    // if a tool call resolves after we close. Harmless, suppress it.
    try {
      sessionRef.current?.close?.();
    } catch (err) {
      console.warn("[voice] cleanup warn (safe to ignore):", err);
    }
    sessionRef.current = null;
    aiAmpRef.current = 0;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const stopVoice = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const startVoice = useCallback(async () => {
    if (status === "connecting" || status === "listening" || status === "speaking") return;

    setError(null);
    setStatus("connecting");
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Keep prior transcript visible so the agent (and the doctor) can reference it.
    // We only clear when the user explicitly hits "O empieza una conversación nueva".
    const priorTranscript = transcript;

    try {
      // 1. Get ephemeral key from server
      const sessRes = await fetch("/api/realtime/session", { method: "POST" });
      if (!sessRes.ok) {
        const body = await sessRes.json().catch(() => ({}));
        throw new Error(body.error ?? `session error ${sessRes.status}`);
      }
      const { ephemeral_key } = (await sessRes.json()) as { ephemeral_key: string };

      // 2. Build the agent (tools proxy to our backend)
      const agent = new RealtimeAgent({
        name: "p4a-voice-agent",
        instructions: VOICE_INSTRUCTIONS(doctorName, priorTranscript),
        tools: buildTools(onProtocolGenerated, () => {
          // After handoff completes, tell the realtime server to STOP
          // creating new responses on user input. The agent finishes its
          // current "Listo…" line and then stays silent even if it hears
          // ambient noise. Prevents the repeated "Listo" loop.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const transport = sessionRef.current?.transport as any;
            // GA Realtime: turn_detection lives under session.audio.input,
            // not at session root. Setting create_response: false tells the
            // server to stop auto-creating responses on incoming audio →
            // the agent says "Listo" once and stays silent until close.
            transport?.sendEvent?.({
              type: "session.update",
              session: {
                type: "realtime",
                audio: {
                  input: {
                    turn_detection: {
                      type: "semantic_vad",
                      create_response: false,
                      interrupt_response: false,
                    },
                  },
                },
              },
            });
          } catch (err) {
            console.warn("[voice] could not disable auto-response:", err);
          }

          // Marca "post-handoff": el listener de audio_stopped cierra la
          // sesión 1.5s después de que el agente termine de hablar su frase
          // "Listo…", lo que en práctica evita el bug de los Listos repetidos.
          postHandoffRef.current = true;

          // Backstop: si por alguna razón no llega audio_stopped, cierra
          // a los 8s. (Era 10s; bajado porque agentes que hablan rápido
          // dejaban demasiado tiempo para re-trigger.)
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(() => {
            cleanup();
            setStatus("idle");
          }, 8000);
        }),
        // "marin" and "cedar" are the highest-quality voices per OpenAI's
        // gpt-realtime-2 guide. Marin is warm/neutral, good for Spanish.
        voice: "marin",
      });

      // 3. Create + connect session (WebRTC handled by SDK)
      const session = new RealtimeSession(agent, {
        model: REALTIME_MODEL,
        transport: "webrtc",
      });
      sessionRef.current = session;

      // 4. Wire events
      session.on("audio_start", () => {
        console.log("[voice] audio_start → speaking");
        setStatus("speaking");
      });
      session.on("audio_stopped", () => {
        console.log("[voice] audio_stopped → listening");
        setStatus("listening");
        // Reset amplitude so bars fall back to baseline immediately
        aiAmpRef.current = 0;

        // Si veníamos de un handoff exitoso, este audio_stopped es el
        // final de la frase "Listo, aquí tienes el protocolo…". Cierra
        // sesión en 1.5s para que NO haya chance de que el modelo
        // repita la frase o vuelva a hablar por ruido ambiental.
        if (postHandoffRef.current) {
          postHandoffRef.current = false;
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(() => {
            cleanup();
            setStatus("idle");
          }, 1500);
        }
      });
      session.on("audio_interrupted", () => {
        setStatus("listening");
        aiAmpRef.current = 0;
      });

      // PCM amplitude of each AI audio chunk → feeds the Waveform.
      // event.data is ArrayBuffer of PCM16. We compute mean(|sample|)/32768.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.on("audio" as any, (event: { data?: ArrayBuffer }) => {
        if (!event?.data) return;
        try {
          const view = new Int16Array(event.data);
          let sum = 0;
          for (let i = 0; i < view.length; i++) sum += Math.abs(view[i]);
          aiAmpRef.current = sum / view.length / 32768;
        } catch (err) {
          console.warn("[voice] audio amp calc failed:", err);
        }
      });
      session.on("agent_tool_start", (_ctx, _agent, tl) => {
        console.log(`[voice] tool start: ${tl.name}`);
        if (tl.name === "handoff_to_reasoning") {
          setThinkingLabel("Generando protocolo… (puede tardar hasta 1 minuto)");
        } else {
          setThinkingLabel("Consultando catálogo…");
        }
        setStatus("thinking");
      });
      session.on("agent_tool_end", (_ctx, _agent, tl) => {
        console.log(`[voice] tool end: ${tl.name}`);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.on("history_updated", (history: any[]) => {
        // Convert SDK history items into chat-style transcript entries
        const entries: TranscriptEntry[] = [];
        for (const item of history) {
          if (item?.type !== "message") continue;
          const role = item.role;
          if (role !== "user" && role !== "assistant") continue;
          const contentArr = Array.isArray(item.content) ? item.content : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = contentArr
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((c: any) => c?.text ?? c?.transcript ?? "")
            .join("")
            .trim();
          // Skip the (start) cue we send to trigger the greeting
          if (text && text !== "(start)") {
            entries.push({
              id: String(item.itemId ?? Math.random()),
              role,
              text,
            });
          }
        }
        setTranscript(entries);
      });

      session.on("error", (err) => {
        console.error("[voice] session error:", err);
        const msg =
          typeof err?.error === "string"
            ? err.error
            : err?.error instanceof Error
            ? err.error.message
            : "Error en la sesión de voz";
        setError(msg);
        setStatus("error");
      });

      await session.connect({ apiKey: ephemeral_key });

      // Trigger the welcome greeting. Without this, semantic_vad waits for
      // user audio before producing any response, so the doctor would have
      // to break silence first.
      try {
        session.sendMessage("(start)");
      } catch (err) {
        console.warn("[voice] could not trigger greeting:", err);
      }

      setStatus("listening");
    } catch (err) {
      console.error("[voice] start failed:", err);
      setError(err instanceof Error ? err.message : "No se pudo iniciar la sesión de voz");
      setStatus("error");
      cleanup();
    }
  }, [cleanup, doctorName, onProtocolGenerated, status, transcript]);

  const statusLabel = (() => {
    switch (status) {
      case "idle": return "Toca el micrófono para empezar";
      case "connecting": return "Conectando…";
      case "listening": return "Escuchando";
      case "speaking": return "Hablando…";
      case "thinking": return thinkingLabel;
      case "error": return error ?? "Error";
    }
  })();

  // "thinking" is handled by the early-return orb above; this is for the mic button
  const isActive = status === "listening" || status === "speaking" || status === "connecting";

  const isThinking = status === "thinking";

  // Voice shell — SOTA pattern (ChatGPT Voice / ElevenLabs / Vapi):
  //   - Outer: flex column, items centered, flex-1 + min-h-0 (NO
  //     justify-center porque eso movía el orb cuando crecía el transcript).
  //   - Stage (orb + mic + status): flex-shrink-0 → nunca se comprime,
  //     siempre visible aunque haya 50 mensajes.
  //   - Transcript: flex-1 min-h-0 overflow-y-auto + overscroll-behavior
  //     contain — ÚNICA zona scrollable de la app. Atrapa el bounce de iOS
  //     para que no se propague al documento.
  return (
    <div className="flex flex-col items-center flex-1 min-h-0 px-4 pt-4 pb-2 gap-3">
      {/* Stage — orb arriba + mic button abajo. flex-shrink-0 garantiza
          que NUNCA se comprime cuando el transcript crece (era el bug que
          empujaba el orb fuera de pantalla). Tamaño del orb bajado a
          140/160 para dejar más espacio vertical al transcript en móvil. */}
      <div className="flex flex-col items-center gap-3 flex-shrink-0">
        <OrbVoice
          size={typeof window !== "undefined" && window.innerWidth < 640 ? 140 : 160}
          state={orbState}
          inputLevelRef={inputLevelRef}
          outputLevelRef={outputLevelRef}
        />

        {/* Mic button — toggle start/stop. Pequeño abajo del orb para que el
            orb sea claramente el centro de atención. */}
        <button
          onClick={isActive ? stopVoice : startVoice}
          disabled={status === "connecting" || isThinking}
          className={`relative w-16 h-16 rounded-full flex items-center justify-center shadow-lg border transition-all duration-200
          ${
            status === "listening" || status === "speaking"
              ? "bg-white border-stone-200 hover:bg-stone-50 active:scale-95"
              : status === "connecting"
              ? "bg-stone-300 cursor-wait border-stone-300"
              : status === "error"
              ? "bg-red-500 hover:bg-red-400 border-red-600 active:scale-95"
              : isThinking
              ? "bg-stone-100 border-stone-200 cursor-wait"
              : "bg-stone-900 hover:bg-stone-800 border-stone-900 active:scale-95"
          }`}
          title={isActive ? "Detener" : "Iniciar sesión de voz"}
          aria-label={isActive ? "Detener sesión de voz" : "Iniciar sesión de voz"}
        >
          {status === "connecting" && (
            <svg className="animate-spin text-stone-500" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          {/* isActive incluye "connecting"; "!isActive" implica idle/thinking/error */}
          {!isActive && (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          )}
          {(status === "listening" || status === "speaking") && (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-stone-700">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          )}
        </button>
      </div>

      <div className="text-center min-h-[2.5rem] flex-shrink-0">
        <p className={`text-sm font-medium transition-colors ${status === "error" ? "text-red-600" : "text-stone-700"}`}>
          {statusLabel}
        </p>
        {status === "idle" && transcript.length === 0 && (
          <p className="text-xs text-stone-500 mt-1">
            Conversación natural — el agente recoge datos y genera el protocolo automáticamente.
          </p>
        )}
        {status === "idle" && transcript.length > 0 && (
          <div className="mt-3 flex flex-col items-center gap-3">
            <p className="text-xs text-stone-500">
              Toca el micrófono para hacer cambios al protocolo actual.
            </p>
            <button
              onClick={() => {
                setTranscript([]);
                // Notifica al padre para que también limpie pendingProtocol
                // + savedSnapshot. Sin esto el toolbar "Archivado" arriba
                // queda colgado aunque el doctor ya está en una conversación
                // nueva.
                onNewConversation?.();
              }}
              className="group inline-flex items-center gap-1.5 text-xs font-medium text-stone-600 bg-white border border-stone-200 hover:border-stone-300 hover:text-stone-900 active:bg-stone-100 rounded-full px-4 py-1.5 shadow-sm transition-all"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:rotate-90 duration-300">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Nueva conversación
            </button>
          </div>
        )}
      </div>

      {transcript.length > 0 && (
        <div
          className="w-full max-w-2xl bg-white border border-stone-200 rounded-2xl p-4 shadow-sm flex-1 min-h-0 overflow-y-auto"
          // overscroll-behavior:contain → si el doctor hace pull-to-refresh
          // dentro del transcript, el rubber-band SE QUEDA aquí (no se
          // propaga al documento ni al PWA shell). Combinado con el lock
          // a nivel html/body, mata el "page scroll" entero.
          style={{ overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
        >
          {/* flex-1 min-h-0 = la única zona scrollable del voice mode.
              El orb + mic + status arriba son flex-shrink-0 (nunca se
              comprimen); el transcript fluye dentro del espacio restante. */}
          <div className="space-y-3">
            {transcript.map((entry) => (
              <div key={entry.id} className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-xs md:max-w-md rounded-2xl px-3.5 py-2 text-sm leading-snug ${
                    entry.role === "user"
                      ? "bg-amber-500 text-white rounded-br-sm"
                      : "bg-stone-100 text-stone-800 rounded-bl-sm"
                  }`}
                >
                  {entry.text}
                </div>
              </div>
            ))}
            {/* Card de acciones para el último output del agente — viene
                desde ChatPage según pendingProtocol/savedSnapshot. Se ve
                como parte del flujo conversacional, no como toolbar. */}
            {bottomActionCard && (
              <div className="pt-2 border-t border-stone-100">{bottomActionCard}</div>
            )}
            <div ref={transcriptBottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}
