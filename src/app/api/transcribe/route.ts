import { getSession } from "@/lib/session";

// Transcribe a short audio clip via OpenAI Whisper.
// Expects multipart/form-data with field "audio" containing the recorded blob.
//
// Why Whisper and not Anthropic: Claude API has no speech-to-text endpoint
// (yet). Whisper-1 is the cheapest reliable option (~$0.006/min).
//
// Voice context: peptide/medical Spanish. We pass a `prompt` hint to bias the
// model toward correct spelling of peptide names that Whisper often garbles
// ("retatrutida", "ipamorelina", "CJC-1295", etc.).

const WHISPER_PROMPT_HINT =
  "Protocolo de péptidos para Peptides4ALL. Vocabulario común: Retatrutida, " +
  "Tirzepatida, Semaglutida, BPC-157, MOTS-c, CJC-1295, Ipamorelin, GHK-Cu, " +
  "TB-500, agua bacteriostática, subcutánea, intramuscular, unidades, mg, mL, " +
  "jeringa de insulina, dosis, frecuencia, reconstitución.";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY no está configurada en .env.local" },
      { status: 500 }
    );
  }

  const form = await req.formData();
  const audio = form.get("audio");

  if (!(audio instanceof Blob)) {
    return Response.json({ error: "missing audio field" }, { status: 400 });
  }

  // Forward to Whisper. We use the file directly (it's already a Blob).
  const whisperForm = new FormData();
  whisperForm.append("file", audio, "recording.webm");
  whisperForm.append("model", "whisper-1");
  whisperForm.append("language", "es"); // explicit Spanish; if doctor speaks English Whisper still handles it
  whisperForm.append("prompt", WHISPER_PROMPT_HINT);
  whisperForm.append("response_format", "json");

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: whisperForm,
  });

  const ms = Date.now() - t0;

  if (!res.ok) {
    const body = await res.text();
    console.error(`[transcribe] Whisper error ${res.status}:`, body);
    return Response.json({ error: `Whisper error: ${res.status}` }, { status: 502 });
  }

  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").trim();
  // NO loggeamos el contenido del transcript — incluye PHI (nombre,
  // edad, condición del paciente). Antes loggeábamos primeros 80 chars
  // y eso era data leak (workflow lo flagged como must-fix). Solo
  // métricas no-sensibles: latencia y tamaño.
  console.log(`[transcribe] ${ms}ms, len=${text.length}`);

  return Response.json({ text });
}
