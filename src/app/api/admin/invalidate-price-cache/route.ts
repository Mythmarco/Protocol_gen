import { getSession } from "@/lib/session";
import { invalidatePriceCache } from "@/lib/price-tool";
import { invalidatePeptideCache } from "@/lib/peptide-tool";

// POST /api/admin/invalidate-price-cache
//
// Limpia los caches in-memory del catálogo (precios del Sheet + peptide
// info de Supabase) sin reiniciar el servidor. Marco lo llama desde el
// iPhone cuando edita la BD/Sheet y quiere que el siguiente PDF refleje
// el cambio inmediato — en vez de esperar el TTL de 60s.
//
// NOTA importante: cada warm container de Vercel tiene su propia copia
// del cache. Si la app está sirviendo desde 3 instancias warm, este
// endpoint solo invalida la que recibe el request. Las otras 2 siguen
// con su copia hasta el siguiente TTL expire. Para invalidación global
// estricta tendríamos que mover el cache a Redis (Upstash que ya
// tenemos) — TODO en sprint futuro si el problema se vuelve real.

export async function POST() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  invalidatePriceCache();
  invalidatePeptideCache();
  console.log(`[admin] price + peptide caches invalidated by ${session.email}`);
  return Response.json({
    ok: true,
    note: "Caches de precios y péptidos invalidados en esta instancia.",
  });
}
