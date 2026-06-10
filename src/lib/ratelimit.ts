import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Rate limiters compartidos para los endpoints más expuestos. Usa Upstash
// Redis serverless (compatible con Vercel edge + node runtime).
//
// Graceful fallback: si UPSTASH_REDIS_REST_URL / TOKEN no están seteados
// (típico en dev local sin Redis), todos los limiters devuelven ok=true
// y agregan un warn al log. Esto evita que la app se rompa para Marco
// cuando corre `npm run dev` o cuando alguien clona el repo. En prod
// los env vars TIENEN QUE existir (chequear en Vercel dashboard).

const HAS_UPSTASH =
  Boolean(process.env.UPSTASH_REDIS_REST_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN);

const redis = HAS_UPSTASH
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// Identificador efectivo del cliente — preferimos email/session.id cuando
// están disponibles para que rate-limit por IP no aplique castigos
// colectivos detrás de un NAT. IP es el fallback.
export function getClientIp(req: Request): string {
  // Vercel-specific headers (también funcionan en Cloudflare/Netlify).
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

// Factory: cada limiter es lazy. Si HAS_UPSTASH=false, la función
// `.limit()` siempre regresa {success: true}.
function makeLimiter(
  tokens: number,
  window: Parameters<typeof Ratelimit.slidingWindow>[1],
  prefix: string
) {
  if (!redis) {
    return {
      limit: async (_: string) => ({
        success: true,
        limit: tokens,
        remaining: tokens,
        reset: Date.now() + 60_000,
        pending: Promise.resolve(),
      }),
    };
  }
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tokens, window),
    analytics: false,
    prefix,
  });
}

// Prefijo de app — namespace para que protocol-gen y CodexMed (u otra
// app) puedan COMPARTIR el mismo Upstash Redis sin colisionar. Cambia
// "p4a:" si reusas este archivo en otra app.
const APP = "p4a:";

// Signin: 5 intentos por email cada 15 min, 20 por IP cada 15 min.
// Ratios sacados del informe del workflow SOTA — el límite por email
// previene brute force contra una cuenta específica; el límite por IP
// previene enumeración de cuentas o ataque distribuido desde la misma IP.
export const signinByEmail = makeLimiter(5, "15 m", `${APP}rl:signin:email`);
export const signinByIp = makeLimiter(20, "15 m", `${APP}rl:signin:ip`);

// API calls de LLM/transcribe — protegen el budget de OpenAI.
// 30 transcripciones por minuto / 200 por día por session — suficiente
// para uso normal en consulta, suficientemente restrictivo para que un
// bug o un cliente comprometido no reviente la cuenta de OpenAI.
export const transcribePerMin = makeLimiter(30, "1 m", `${APP}rl:transcribe:min`);
export const transcribePerDay = makeLimiter(200, "1 d", `${APP}rl:transcribe:day`);

// Chat / generate-protocol — más conservador porque cada llamada cuesta más.
export const llmPerMin = makeLimiter(15, "1 m", `${APP}rl:llm:min`);
export const llmPerDay = makeLimiter(150, "1 d", `${APP}rl:llm:day`);

// Realtime session creation — usuario crea sesiones a velocidad humana,
// 10/min es generoso.
export const realtimePerMin = makeLimiter(10, "1 m", `${APP}rl:rt:min`);

// Util para chequeo combinado (email + ip) — devuelve el primer fallo.
// Permite responder con 429 + Retry-After preciso.
export async function checkSigninRateLimit(
  email: string,
  ip: string
): Promise<{
  ok: boolean;
  reason?: "email" | "ip";
  reset?: number;
}> {
  const [emailRes, ipRes] = await Promise.all([
    signinByEmail.limit(`email:${email}`),
    signinByIp.limit(`ip:${ip}`),
  ]);
  if (!emailRes.success) return { ok: false, reason: "email", reset: emailRes.reset };
  if (!ipRes.success) return { ok: false, reason: "ip", reset: ipRes.reset };
  return { ok: true };
}
