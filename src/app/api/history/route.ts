import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createAdminClient } from "@/utils/supabase/admin";

export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("protocolos")
    .select("id, paciente_nombre, descripcion, fecha_creacion")
    .eq("creado_por", session.id)
    .order("fecha_creacion", { ascending: false })
    .limit(50);

  return NextResponse.json({ items: data ?? [] });
}
