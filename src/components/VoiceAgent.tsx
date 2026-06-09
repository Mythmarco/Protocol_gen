"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import type { ProtocoloData } from "@/lib/protocol-types";
import { useVoiceLevels } from "@/hooks/useVoiceLevels";
import { injectMobilePreviewCloseButton } from "@/lib/preview-overlay";
import OrbVoice, { type OrbState } from "./OrbVoice";

// OrbVoice ahora es CSS-only (sin three.js) — import directo. La versión
// anterior lo cargaba con next/dynamic para excluir three del bundle;
// como ya no usamos three, el lazy-load es innecesario y agrega un flash
// de placeholder al entrar a voice mode.

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

interface HandoffCallbacks {
  /** Disparado APENAS handoff_to_reasoning empieza — antes del fetch.
   *  Sirve para cancelar audio + cambiar el status del UI a "Generando…" */
  onHandoffStart: () => void;
  /** Recibe el protocolo ya producido. El consumer (ChatPage) setea
   *  pendingProtocol → bottomActionCard aparece debajo del último mensaje. */
  onHandoff: (data: ProtocoloData) => void;
  /** Tras escribir el HTML en la pestaña nueva (o fallar), inyecta el
   *  mensaje sintético "Listo…" en el transcript y cierra la sesión.
   *  El agente NO habla este mensaje — lo escribimos como texto. */
  onHandoffDone: (message: string) => void;
}

function buildTools(callbacks: HandoffCallbacks) {
  const { onHandoffStart, onHandoff, onHandoffDone } = callbacks;
  // Detección de móvil — solo intentamos pre-abrir tab en móvil porque en
  // desktop el modal es más cómodo (pinch-zoom no aplica).
  const isMobile = () =>
    typeof window !== "undefined" && window.innerWidth < 768;

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

        // Step 0 — corta audio del agente y voltea el UI a "Generando…".
        // Esto NO depende del modelo (que ya demostró no ser confiable
        // para callar tras la tool call). El UI muestra el orb thinking
        // con label "Generando protocolo…" y el doctor entiende que la
        // espera es del backend, no de él.
        onHandoffStart();

        // Step 1 (móvil): abrir tab placeholder SINCRÓNICAMENTE en el
        // mismo tick en que el tool execute arranca. En iOS PWA standalone
        // a veces funciona aunque el gesture original (tap del mic) sea
        // viejo — es la mejor heurística que tenemos. Si el popup blocker
        // lo rechaza, `bridgeTab` será null y mostramos modal in-app.
        let bridgeTab: Window | null = null;
        if (isMobile()) {
          try {
            bridgeTab = window.open("about:blank", "_blank");
            if (bridgeTab) {
              bridgeTab.document.write(
                '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generando protocolo…</title></head><body style="margin:0;background:#f5f3f1;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#666"><div style="text-align:center"><div style="font-size:42px;margin-bottom:14px">🧬</div><p style="margin:0;font-size:16px">Generando protocolo…</p><p style="margin:8px 0 0;font-size:13px;color:#999">Puede tardar hasta 1 minuto</p></div></body></html>'
              );
            }
          } catch (err) {
            console.warn("[voice] could not pre-open preview tab:", err);
            bridgeTab = null;
          }
        }

        // Step 2 — genera el protocolo (~15-30s con GPT-5.5 reasoning).
        const res = await fetch("/api/generate-protocol", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gathered }),
        });
        if (!res.ok) {
          if (bridgeTab && !bridgeTab.closed) bridgeTab.close();
          const err = await res.json().catch(() => ({}));
          onHandoffDone(
            "Hubo un error generando el protocolo. Vuelve a intentar tocando el micrófono."
          );
          return JSON.stringify({
            error: err.error ?? `handoff failed: ${res.status}`,
          });
        }
        const { protocol } = (await res.json()) as { protocol: ProtocoloData };

        // Step 3 — renderiza HTML del preview y navega la pestaña al
        // documento nuevo via Blob URL. Antes usábamos document.write
        // sobre el about:blank pre-abierto, pero iOS Safari NO re-procesa
        // el <meta viewport> cuando el doc se reescribe en vivo — se
        // quedaba con el "width=device-width, initial-scale=1" del
        // placeholder y el PDF (que usa width=794) salía mal alineado
        // hasta que el doctor cerraba y abría. Navegar a un Blob URL
        // fuerza un load completo del documento → meta viewport se lee
        // limpio, render fit-to-width desde el primer paint.
        let tabFilled = false;
        if (bridgeTab && !bridgeTab.closed) {
          try {
            const previewRes = await fetch("/api/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ protocolData: protocol }),
            });
            if (previewRes.ok) {
              const html = await previewRes.text();
              const htmlWithClose = injectMobilePreviewCloseButton(html);
              const blob = new Blob([htmlWithClose], {
                type: "text/html;charset=utf-8",
              });
              const blobUrl = URL.createObjectURL(blob);
              // location.replace en lugar de href = evita que "atrás" en
              // Safari mande al placeholder vacío.
              bridgeTab.location.replace(blobUrl);
              tabFilled = true;
              // No revokemos el blob inmediatamente — Safari necesita el
              // URL durante el load. Revocamos en 60s para no fugar
              // memoria si el doctor deja el tab abierto.
              setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
            } else {
              bridgeTab.close();
            }
          } catch (err) {
            console.warn("[voice] preview render to bridge tab failed:", err);
            try {
              bridgeTab.close();
            } catch {}
          }
        }

        // Step 4 — entrega el protocolo a ChatPage. Esto setea
        // pendingProtocol → bottomActionCard aparece bajo el último mensaje.
        onHandoff(protocol);

        // Step 5 — inyecta el mensaje sintético "Listo…" en el transcript
        // y cierra la sesión. El agente NO va a hablar este mensaje (su
        // audio ya fue cancelado en onHandoffStart y la sesión se cierra
        // aquí). Es texto puro — lo escribimos directamente en el UI.
        const closingMessage = tabFilled
          ? `Listo, el protocolo de ${protocol.paciente.nombre} se abrió en una pestaña nueva. Si necesitas cambios, vuelve a tocar el micrófono.`
          : `Listo, el protocolo de ${protocol.paciente.nombre} está abajo. Si necesitas cambios, vuelve a tocar el micrófono.`;
        onHandoffDone(closingMessage);

        // El return ya no importa para el agente (sesión cerrada) — lo
        // dejamos por contrato con el SDK.
        return JSON.stringify({
          ok: true,
          paciente: protocol.paciente.nombre,
          preview_opened_in_new_tab: tabFilled,
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

# 🚫 PALABRAS Y FRASES TOTALMENTE PROHIBIDAS AL INICIO DE UN TURNO
NUNCA empieces un turno con ninguna de estas — son la causa #1 de que el doctor sienta que repites demasiado:

| Prohibido | Por qué |
|---|---|
| "Anotado: …" | Repite el dato. |
| "Muy bien, …" | Filler vacío. |
| "Perfecto, …" | Filler vacío + sonido condescendiente. |
| "Confirmo: …" | Solo permitido en 3 casos específicos (ver abajo). |
| "Entendido, …" | Filler. |
| "Listo, …" | Solo permitido como mensaje final del handoff. |
| "Ok, …" | Filler. |
| "Claro, …" | Filler. |
| "Ya, …" | Filler. |
| Repetir el dato que acaba de decir el doctor | Hace al doctor sentir que no lo escuchas a la primera. |

# Regla de oro: dato recibido → SILENCIO interno + siguiente pregunta
Cuando el doctor te da un dato, NO lo acuses ni lo repitas. Solo avanza.

❌ Doctor: "En dólares, por favor." → Tú: "¿Confirmo: moneda en dólares, correcto?"
✅ Doctor: "En dólares, por favor." → Tú: "[siguiente pregunta del flujo, ej. envío]"

❌ Doctor: "87 kilos." → Tú: "Anotado, 87 kg. ¿Estatura?"
✅ Doctor: "87 kilos." → Tú: "¿Estatura?"

❌ Doctor: "Diego de la Garza." → Tú: "Diego de la Garza, perfecto. ¿Peso?"
✅ Doctor: "Diego de la Garza." → Tú: "¿Peso?"

❌ Doctor: "Retatrutida 8 mg semanal." → Tú: "Anotado: Retatrutida ocho miligramos semanal. ¿Día?"
✅ Doctor: "Retatrutida 8 mg semanal." → Tú: "¿Qué día de la semana?"

# Las 3 ÚNICAS excepciones donde SÍ confirmas (1 vez, no más)
Confirma SOLO en estos 3 casos — porque un error aquí arruina el protocolo entero. Nada más amerita confirm.

1. **Nombre del paciente** la primera vez (riesgo de error de transcripción):
   ✅ "¿Pedro Juárez, correcto?"

2. **Presentación del vial en mg** la primera vez (15 vs 50 cambia toda la dosificación):
   ✅ Doctor: "Reta de 15 mg" → Tú: "¿Quince miligramos, correcto?"

3. **Dosis prescrita en mg** la primera vez (8 mg vs 80 mg es vida-o-muerte):
   ✅ Doctor: "Ocho miligramos por aplicación" → Tú: "¿Ocho miligramos, correcto?"

NUNCA confirmes: moneda, peso, estatura, edad, objetivo, envío, frecuencia, día de la semana, duración. **Estos se aceptan en silencio.**

# Anti-resumen
NO resumas lo que llevas hasta el momento. El doctor lo recuerda. NO digas "vamos a armar el protocolo con tres viales de Retatrutida: uno de quince mg, otro de treinta…" — eso es repetir TODO. El doctor te dictó esos datos hace 30 segundos, los recuerda.

Si el médico repite algo que ya te dio (porque pensaste que no lo capturaste), NO se lo vuelvas a confirmar — solo úsalo y avanza.

NO hagas un resumen final antes del handoff. El doctor ve la vista previa en pantalla. Di SOLO "Dame un momento mientras genero el protocolo." y llama la tool. UNA frase, nada más.

# Language (default español — switch a inglés solo si el doctor lo pide explícito)
Por default la conversación es en **español**. El transcriptor (Whisper) está configurado en español para evitar errores cuando el audio es ruidoso en móvil.

Si el doctor te dice explícitamente "hablemos en inglés" / "switch to English" / "let's do this in English", entonces:
- Responde en inglés desde ese turno.
- El transcript en pantalla puede salir traducido o raro porque Whisper sigue en español — IGNORA eso, tú confía en lo que el doctor dijo en audio.

Si el doctor mezcla palabras técnicas en inglés dentro de una frase en español ("Retatrutide 15 mg"), NO es un cambio de idioma — sigue respondiendo en español.

El idioma del **PDF final** (gathered.metadata.idioma) se decide aparte: pregúntalo si no es obvio del contexto.

# Reasoning
- Para respuestas simples (reconocimientos, "ok", "entendido"), no razones — responde directo.
- Para decisiones de tools, validaciones de dosis, o lógica clínica, razona internamente antes de actuar.
- Si el audio no es claro, NO razones — pide aclaración.

# Preambles
Cuando vayas a llamar un tool que pueda tardar (especialmente \`handoff_to_reasoning\`), di una frase corta antes: "Voy a buscar eso", "Déjame validar el precio", "Dame un momento mientras genero el protocolo".
NO uses preambles cuando: la respuesta es inmediata, el médico solo confirma o corrige, o el audio fue silencio.

# Verbosity
- Preguntas: UNA a la vez.
- Confirmaciones: SOLO los 3 casos críticos definidos arriba (nombre paciente, presentación vial mg, dosis mg). Nada más.
- Datos cotidianos (peso, edad, estatura, moneda, envío): acepta en SILENCIO + siguiente pregunta. Si no escuchaste claro, pide repetir — pero NO confirmes.
- Después del handoff: UNA frase corta y nada más. Ver sección de handoff abajo para la frase exacta. NO leas el contenido.

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
Esta tool dispara la generación del protocolo (GPT-5.5 + PDF). El doctor verá la vista previa al final, así que **no necesitas confirmar nada verbalmente** antes — eso solo lo hace repetitivo.

**Secuencia EXACTA — sigue al pie de la letra:**
1. Di UNA SOLA frase corta: "Dame un momento mientras genero el protocolo." Punto. NO resúmenes, NO listas, NO "estoy procesando", NO nada más.
2. INMEDIATAMENTE llama \`handoff_to_reasoning\` con los parámetros estructurados.
3. **SILENCIO ABSOLUTO** hasta que la tool te devuelva un \`function_call_output\` en tu contexto con \`ok: true\`. Esto toma 20-60 segundos.
   - Durante esos 20-60s: NO hables. NO digas "Listo". NO digas "ya casi". NO digas "preparando". NO digas NADA.
   - Si escuchas cualquier audio (ruido, el doctor, lo que sea), llama \`wait_for_user\`. NO contestes.
4. CUANDO veas el \`function_call_output\` con \`ok: true\` Y un campo \`paciente: "..."\` en TU CONTEXTO: di EXACTAMENTE UNA VEZ:
   - Si \`preview_opened_in_new_tab: true\`: "Listo, el protocolo de [nombre del paciente] se abrió en una pestaña nueva. Si necesitas cambios, toca el micrófono otra vez."
   - Si \`preview_opened_in_new_tab: false\` (o no está): "Listo, el protocolo de [nombre del paciente] está abajo, toca 'Vista previa' para abrirlo. Si necesitas cambios, toca el micrófono otra vez."
5. Después de esa frase: **silencio absoluto y total**. La sesión se cierra sola.

**Reglas duras post-handoff (CRITICAL — el doctor ya se quejó del bug):**
- Di tu frase de cierre **UNA SOLA VEZ**. Nunca dos. Nunca tres.
- Después de hablar: **no respondas a nada más**. Aunque el doctor diga algo, aunque haya ruido, aunque escuches el eco de tu propia voz. **Cero**.
- Si por error te tienta repetir "Listo…", **PARA**. La sesión se cierra automáticamente en menos de 2 segundos.

❌ MAL: "Listo, aquí tienes el protocolo." (silencio) "Listo, aquí tienes el protocolo." (silencio) "Listo…"
✅ BIEN: "Listo, el protocolo de Ana se abrió en una pestaña nueva, si necesitas cambios toca el micrófono otra vez." (silencio absoluto hasta cierre)

**Regla crítica — NO ANTICIPES "Listo":**
NUNCA digas "Listo…" antes de ver el \`function_call_output\` con \`ok: true\` en tu contexto. Si lo dices antes, el doctor ve una vista previa vacía porque el JSON aún no está generado. Esto YA pasó como bug — no lo repitas.

NO digas "¿Confirmas?", "¿Te parece bien?", "¿Estamos listos?" antes del handoff.
NO leas el JSON en voz. NO leas el contenido del protocolo (péptidos, dosis, total).

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
3. **NUNCA preguntes NI CONFIRMES un campo CAPTURADO** — salvo que esté en la lista de 3 excepciones críticas (nombre paciente, presentación vial mg, dosis mg). Para TODO lo demás (peso, estatura, edad, objetivo, moneda, envío, duración, frecuencia, días, idioma): asume capturado, NO repitas, avanza al siguiente campo en FALTA.
   - Si tienes duda real (audio cortado/ruido), pide repetir SIN nombrar el campo: "¿me lo repites?" o "perdona, no te escuché bien".
   - NUNCA digas "Confirmo: <valor>" ni "¿correcto?" sobre datos fuera de las 3 excepciones.
   - NUNCA hagas eco del valor que acabas de capturar ("Anotado: 87 kg", "Muy bien, USD").
4. Pregunta SOLO el PRIMER campo que sigue en FALTA. UNA cosa a la vez.
5. Si el doctor te da un valor que no pediste, ACEPTALO y márcalo CAPTURADO. No lo ignores ni vuelvas a tu pregunta original.

## REGLA META anti-repetición
Si ya pronunciaste un dato del paciente en este turno o el anterior, NO lo vuelvas a pronunciar en el siguiente. Repetir un dato dos veces ROMPE la consulta y es PROHIBIDO. Si necesitas confirmar algo crítico, hazlo UNA vez, espera la respuesta, y si la respuesta es ambigua, asume que sí y avanza.

Estado mental por defecto: **"ya tengo el dato, sigo adelante"**. No vuelvas atrás a verificar salvo que el doctor diga explícitamente "espera" o "corrijo".

## Confirmaciones digit-by-digit (SOLO para los 3 casos críticos)
Lee de vuelta dígito por dígito (no como número entero) SOLO al capturar:
- Presentación del vial en mg → "uno-cinco miligramos" para 15
- Dosis por aplicación en mg → "ocho miligramos" para 8

Estas son las dos confirmaciones permitidas en formato digit-by-digit. Para cualquier OTRO valor numérico (edad, peso, estatura, unidades de jeringa, monto de envío) NO repitas — acepta en silencio.

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
- **NUNCA cotices jeringas.** Esa es la ÚNICA exclusión absoluta. El paciente las consigue aparte.
- **SÍ se cotiza agua bacteriostática** (al menos un frasco si el paciente la necesita para reconstituir) y CUALQUIER otro insumo o péptido del catálogo que el doctor pida. NO inventes la regla "solo se cotizan péptidos" — eso es FALSO.
- Si el doctor pide explícitamente agregar algo (agua bacteriostática, viales adicionales, lo que sea que NO sea jeringa), agrégalo SIN cuestionar. Solo recházalo si es una jeringa.
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
  // True mientras el handoff está corriendo (entre handoff_to_reasoning
  // start y done). Cuando true, el orb se queda en "thinking" y el mic
  // está mute. NO usamos al agente para nada — el cierre lo controlamos
  // nosotros desde onHandoffDone.
  const handoffActiveRef = useRef(false);

  // Mic mute helper — accede al MediaStreamTrack del audio sender del
  // WebRTC peer connection y lo des/habilita. Critico para:
  //   1) Eco: cuando la IA habla, el mic captura su voz (especialmente en
  //      móvil con altavoz). Whisper la transcribe como input del usuario,
  //      el modelo se interrumpe a sí mismo. Mute mientras AI habla → fix.
  //   2) Loop "Listo": después del handoff queremos garantizar que NO se
  //      crea respuesta nueva por ruido ambiental. create_response:false
  //      ayuda pero el mute es definitivo.
  const setMicEnabled = useCallback((enabled: boolean) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transport = sessionRef.current?.transport as any;
      const pc: RTCPeerConnection | undefined =
        transport?.pc ?? transport?.peerConnection ?? transport?._pc;
      if (!pc) return;
      for (const sender of pc.getSenders()) {
        const track = sender.track;
        if (track && track.kind === "audio") {
          track.enabled = enabled;
        }
      }
    } catch (err) {
      console.warn("[voice] setMicEnabled failed:", err);
    }
  }, []);

  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    // También scrollea cuando el bottomActionCard cambia — al cargar un
    // protocolo de historial el card aparece y el doctor debe verlo, no
    // tener que scrollear manualmente para encontrarlo.
  }, [transcript, bottomActionCard]);

  const cleanup = useCallback(() => {
    // Wrap in try/catch — the SDK throws "WebRTC data channel is not connected"
    // if a tool call resolves after we close. Harmless, suppress it.
    try {
      sessionRef.current?.close?.();
    } catch (err) {
      console.warn("[voice] cleanup warn (safe to ignore):", err);
    }
    sessionRef.current = null;
    aiAmpRef.current = 0;
    handoffActiveRef.current = false;
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
    handoffActiveRef.current = false;
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
        tools: buildTools({
          onHandoffStart: () => {
            // Marcar handoff activo + cortar cualquier audio en vuelo del
            // agente. Estrategia: silenciar el <audio> element del SDK
            // (el que reproduce el PCM remoto del modelo) en vez de mandar
            // response.cancel — esa última hacía race con el WebRTC y
            // disparaba un 'error' event que el doctor veía como "Error
            // en la sesión de voz" justo cuando el handoff arrancaba.
            // Mutear el elemento es 100% local: el modelo puede seguir
            // generando audio en el servidor pero el doctor no lo oye, y
            // 25s después cleanup() cierra la sesión definitivamente.
            handoffActiveRef.current = true;
            setStatus("thinking");
            setThinkingLabel("Generando protocolo… (15-30 segundos)");
            setMicEnabled(false);
            try {
              // El SDK inyecta uno o más <audio autoplay> en el DOM para
              // reproducir el remote stream. Los mute todos — afecta solo
              // a este flow porque cleanup() los quita al cerrar.
              document
                .querySelectorAll("audio")
                .forEach((el) => {
                  el.muted = true;
                  try { el.pause(); } catch {}
                });
            } catch (err) {
              console.warn("[voice] could not mute audio elements:", err);
            }
          },
          onHandoff: onProtocolGenerated,
          onHandoffDone: (closingMessage) => {
            // Inyecta el mensaje sintético como turno assistant en el
            // transcript LOCAL. NO va por el SDK (que llamaría al agente
            // a hablarlo) — es texto puro que el doctor lee al volver al
            // PWA tras cerrar la pestaña del PDF.
            setTranscript((prev) => [
              ...prev,
              {
                id: `synthetic-${Date.now()}`,
                role: "assistant",
                text: closingMessage,
              },
            ]);
            // Cierra sesión inmediatamente. No esperamos audio_stopped, no
            // damos chance al agente de "repetir Listo" — la sesión se
            // muere aquí y los botones del action card (que ya viven en
            // bottomActionCard porque pendingProtocol está seteado) son
            // la única interacción posible. Para nuevos cambios, el doctor
            // toca el mic otra vez → startVoice nueva.
            cleanup();
            setStatus("idle");
          },
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
        console.log("[voice] audio_start → speaking (muting mic)");
        setStatus("speaking");
        // Mute mic mientras la IA habla — sin esto, el mic capta la voz
        // de la IA (especialmente en móvil con altavoz), Whisper la
        // transcribe como input del usuario y el agente se "interrumpe"
        // o se escucha a sí mismo. echoCancellation de getUserMedia no
        // es suficiente en iOS PWA cuando el audio output viene del SDK
        // de Realtime (no del MediaStream local).
        // Trade-off: el doctor no puede interrumpir mid-sentence (barge-
        // in), pero la IA habla en frases cortas y el doctor puede tocar
        // el mic STOP si necesita parar.
        setMicEnabled(false);
      });
      session.on("audio_stopped", () => {
        console.log("[voice] audio_stopped → listening (unmuting mic)");
        // Si el handoff está activo, NO volvemos a listening — el status
        // se queda en "thinking" hasta que onHandoffDone cierre la sesión.
        if (handoffActiveRef.current) return;
        setStatus("listening");
        aiAmpRef.current = 0;
        setMicEnabled(true);
      });
      session.on("audio_interrupted", () => {
        // El SDK interrumpió a la IA mid-speech (barge-in o nuestro
        // response.cancel del handoff). Si NO estamos en handoff, volvemos
        // a listening y re-habilitamos el mic.
        if (handoffActiveRef.current) return;
        setStatus("listening");
        aiAmpRef.current = 0;
        setMicEnabled(true);
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
        // handoff_to_reasoning ya pone su propio label en onHandoffStart
        // — no lo pisamos aquí. Para tools rápidas mostramos "Consultando".
        if (tl.name === "handoff_to_reasoning") return;
        setThinkingLabel("Consultando catálogo…");
        setStatus("thinking");
      });
      session.on("agent_tool_end", (_ctx, _agent, tl) => {
        console.log(`[voice] tool end: ${tl.name}`);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session.on("history_updated", (history: any[]) => {
        // Si el handoff ya terminó (sesión cerrada o cerrándose), NO
        // pisamos el transcript — onHandoffDone ya agregó el mensaje
        // sintético "Listo…" y un history_updated tardío del SDK lo
        // borraría. Es una race condition común con close() async.
        if (handoffActiveRef.current) return;
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
        // Durante el handoff hay un race del WebRTC normal (la sesión se
        // está cerrando, el tool execute resuelve después, el SDK intenta
        // mandar function_call_output por un channel ya cerrado). Eso
        // dispara un 'error' que NO es del doctor — es ruido del cierre.
        // Si lo mostramos, el doctor ve "Error en la sesión de voz" justo
        // cuando debería ver "Generando protocolo…". Lo ignoramos.
        if (handoffActiveRef.current) {
          console.warn("[voice] suppressed error during handoff");
          return;
        }
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
  }, [cleanup, doctorName, onProtocolGenerated, setMicEnabled, status, transcript]);

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
          size={typeof window !== "undefined" && window.innerWidth < 640 ? 112 : 132}
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
            {(() => {
              // Localiza el índice del último mensaje assistant — el action
              // card (vista previa / descargar / guardar / compartir) se
              // ancla DENTRO de ese mismo bubble para que se sienta como
              // parte del último output del agente, no como toolbar.
              let lastAssistantIdx = -1;
              for (let i = transcript.length - 1; i >= 0; i--) {
                if (transcript[i].role === "assistant") {
                  lastAssistantIdx = i;
                  break;
                }
              }
              return transcript.map((entry, i) => {
                const isLastAssistant = i === lastAssistantIdx;
                const showCard = isLastAssistant && bottomActionCard;
                return (
                  <div
                    key={entry.id}
                    className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`${
                        showCard ? "max-w-sm md:max-w-md" : "max-w-xs md:max-w-md"
                      } rounded-2xl px-3.5 py-2 text-sm leading-snug ${
                        entry.role === "user"
                          ? "bg-amber-500 text-white rounded-br-sm"
                          : "bg-stone-100 text-stone-800 rounded-bl-sm"
                      }`}
                    >
                      <div>{entry.text}</div>
                      {showCard && (
                        <div className="mt-2 pt-2 border-t border-stone-200/60">
                          {bottomActionCard}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
            <div ref={transcriptBottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}
