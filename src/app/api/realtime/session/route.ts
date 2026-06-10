import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getSession } from "@/lib/session";

// Mints a Realtime client secret (ephemeral key) using OpenAI's GA endpoint
// via the official SDK helper: client.realtime.clientSecrets.create().
//
// The Beta endpoint POST /v1/realtime/sessions was discontinued. The GA
// endpoint is POST /v1/realtime/client_secrets and uses a different body
// shape (nested under `session`, with `type: "realtime"` and `audio.input/
// audio.output` blocks).
//
// We only set minimal session config here. The browser-side @openai/agents
// SDK overrides instructions, tools, and voice via session.update events
// after connecting.

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REALTIME_MODEL = (process.env.OPENAI_REALTIME_MODEL ||
  "gpt-realtime-2") as
  | "gpt-realtime-2"
  | "gpt-realtime-1.5"
  | "gpt-realtime"
  | (string & {});

const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";

export async function POST() {
  const userSession = await getSession();
  if (!userSession) return new Response("Unauthorized", { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY missing on server" }, { status: 500 });
  }

  try {
    const secret = await client.realtime.clientSecrets.create({
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        output_modalities: ["audio"],
        // NOTA: probé parallel_tool_calls aquí pero la GA Realtime API
        // devuelve 400 'Unsupported option for this model' al crear el
        // client secret. El modelo gpt-realtime-2 SÍ soporta tool calls
        // paralelas en runtime (controlado en cada response.create event,
        // no en la sesión global). Lo dejamos sin setear — el agente
        // sigue pudiendo emitirlas si los tools son independientes.
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // semantic_vad + eagerness "low" — espera más antes de cortar
            // al usuario. Doctor reportó interrupciones fantasma cuando NO
            // estaba hablando: el VAD detectaba ruido ambiental como voz.
            turn_detection: { type: "semantic_vad", eagerness: "low" },
            // near_field = micrófono de teléfono en mano (vs far_field para
            // micrófonos de habitación tipo Alexa). Filtra mucho mejor el
            // ruido de fondo y reduce falsos positivos del VAD. Recomendado
            // por OpenAI para apps móviles donde el doctor tiene el iPhone
            // en mano durante consulta.
            noise_reduction: { type: "near_field" },
            // Whisper FORZADO a español. El auto-detect (sin language) fue
            // un experimento para soportar inglés — falló en móvil donde
            // el ruido ambiental hacía que Whisper devolviera transcripts
            // en otros idiomas (cirílico, hebreo) en frases ambiguas. El
            // doctor lo reportó como "mi transcripción sale en otro idioma".
            // Si el doctor quiere inglés, lo pide explícito y el agente
            // responde en inglés aunque el transcript en pantalla
            // pueda salir traducido (trade-off aceptable — el audio es
            // la fuente de verdad para el modelo).
            transcription: { model: "gpt-realtime-whisper", language: "es" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: REALTIME_VOICE,
          },
        },
      },
    });

    return NextResponse.json({
      ephemeral_key: secret.value,
      model: REALTIME_MODEL,
      expires_at: secret.expires_at,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[realtime/session] OpenAI error:", message);
    return NextResponse.json(
      { error: `OpenAI session error: ${message}` },
      { status: 502 }
    );
  }
}
