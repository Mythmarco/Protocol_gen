import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getDoctorFxRate, setDoctorFxRate } from "@/lib/settings";
import { z } from "zod";

// GET  /api/fx → { rate: 18.50, source: "user" | "env" | "default" }
// POST /api/fx body { rate: 19.2 } → { rate: 19.20, source: "user" }
//
// El cliente lo consume:
//  - Cuenta sheet muestra el rate actual + source (etiqueta "tu valor" /
//    "default Vercel" / "fallback") para que el doctor sepa qué hay
//    de fondo.
//  - Al guardar el doctor lo actualiza con POST.
//  - enrichProtocolMetadata lo lee en cada cotización USD para que el
//    PDF salga con el rate vigente al momento del guardado.

export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const fx = await getDoctorFxRate(session.id);
  return NextResponse.json(fx);
}

const POST_SCHEMA = z.object({
  rate: z.number().positive(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = POST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const result = await setDoctorFxRate(session.id, parsed.data.rate);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ rate: result.rate, source: "user" });
}
