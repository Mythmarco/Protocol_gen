import { getSession } from "@/lib/session";
import { invalidatePriceCache } from "@/lib/price-tool";

// POST /api/admin/invalidate-price-cache
//
// Limpia el cache in-memory del Google Sheet de precios sin reiniciar
// el servidor. Marco lo llama desde el iPhone (o el sidebar admin más
// adelante) cuando edita el Sheet y quiere que el siguiente PDF refleje
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
  console.log(`[admin] price cache invalidated by ${session.email}`);
  return Response.json({ ok: true, note: "Cache invalidado en esta instancia." });
}
