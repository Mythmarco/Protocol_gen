import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createAdminClient } from "@/utils/supabase/admin";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("protocolos")
    .select("datos_json, conversacion, conversacion_modo, folio, drive_url")
    .eq("id", id)
    .eq("creado_por", session.id) // app-layer enforcement: only owner can read
    .maybeSingle();

  if (error || !data) {
    return new Response("Not found", { status: 404 });
  }

  return NextResponse.json({
    datos_json: data.datos_json,
    conversacion: data.conversacion ?? [],
    conversacion_modo: data.conversacion_modo ?? "text",
    folio: data.folio ?? null,
    drive_url: data.drive_url ?? null,
  });
}
