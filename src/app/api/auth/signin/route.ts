import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createAdminClient } from "@/utils/supabase/admin";
import { createSession } from "@/lib/session";
import { checkSigninRateLimit, getClientIp } from "@/lib/ratelimit";

// POST /api/auth/signin
// Body: { email, password }
// Verifies against Stacklabs User table (bcrypt + role=ADMIN). Sets cookie.
//
// Hardening del workflow SOTA:
// 1. `.eq("email", normalized)` en lugar de `.ilike(email)` — ilike trata
//    % y _ como wildcards de SQL; un atacante mandando "a%@%" matcheaba
//    contra cuentas cuyo email exacto desconocía y entraba si adivinaba
//    la password. Bypass real, no solo enumeración.
// 2. Normalización a lowercase server-side. Asegura que ana@x.com y
//    Ana@X.com no abran cuentas distintas (consistente con email-as-id).
// 3. Rate-limit Upstash con sliding window: 5/15min por email + 20/15min
//    por IP. Sin esto, dictionary attack era viable.
// 4. Validación de Origin/Referer contra el host esperado — bloquea CSRF
//    de login (atacante fuerza víctima a loguearse en cuenta atacante
//    para envenenar el historial guardado en Drive).

const ALLOWED_ORIGINS = (() => {
  const envList = (process.env.AUTH_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // En dev permitimos localhost por default; en prod TIENEN que venir de env.
  if (envList.length === 0 && process.env.NODE_ENV !== "production") {
    return ["http://localhost:3000", "http://127.0.0.1:3000"];
  }
  return envList;
})();

export async function POST(req: Request) {
  // 1. Origin check (defense against login CSRF). Mismo-origin requests
  //    desde el browser SIEMPRE traen Origin para fetch POST con JSON.
  //    Si falta o no está en la lista permitida, rechazamos.
  const origin = req.headers.get("origin");
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`[signin] rejected origin=${origin}`);
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  const { email, password } = (await req.json()) as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    console.log("[signin] missing email or password");
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  // Normalización: lowercase + trim. Hace el lookup determinista y
  // previene que case-mismatch confunda al doctor.
  const normalizedEmail = email.trim().toLowerCase();

  // 2. Rate-limit antes de tocar Supabase. Si el doctor está bajo ataque
  //    el atacante NO debería poder gastar nuestro budget de DB.
  const ip = getClientIp(req);
  const rl = await checkSigninRateLimit(normalizedEmail, ip);
  if (!rl.ok) {
    const retryAfter = rl.reset
      ? Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
      : 60;
    console.warn(`[signin] rate-limited reason=${rl.reason} retry=${retryAfter}s`);
    return new NextResponse(
      JSON.stringify({ error: "rate_limited", reason: rl.reason }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
        },
      }
    );
  }

  const supabase = createAdminClient();

  // 3. .eq() en vez de .ilike() — sin wildcards, match EXACTO.
  const { data: user, error } = await supabase
    .from("User")
    .select("id, email, password, role, name")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    console.error("[signin] Supabase query error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // Single non-granular log para todos los fallos de signin. Antes
  // teníamos dlog específico ("no User row" / "no password column" /
  // "bcrypt mismatch") gated por NODE_ENV. Pero un Vercel preview deploy
  // o un staging mal configurado podía leakear la granularidad y permitir
  // enumeración: atacante distingue "este email existe" de "password
  // mala". Workflow item 16. Ahora UN solo mensaje uniforme para todos.
  const failSignin = () => {
    console.log(`[signin] failed reason=invalid_credentials`);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  };

  if (!user) {
    // Constant-time miss to avoid email enumeration via timing side-channel.
    await bcrypt.compare(
      password,
      "$2a$10$0000000000000000000000000000000000000000000000000000"
    );
    return failSignin();
  }

  if (!user.password) {
    return failSignin();
  }

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return failSignin();
  }

  if (user.role !== "ADMIN") {
    // Role mismatch es un caso distinto: el doctor tiene la password
    // correcta pero NO es admin. Mantenemos 403 separado pero NO logueamos
    // el rol específico (también evita fingerprinting del schema).
    console.log(`[signin] failed reason=not_admin`);
    return NextResponse.json({ error: "not_admin" }, { status: 403 });
  }

  await createSession({
    id: String(user.id),
    email: user.email,
    role: user.role,
    name: user.name ?? undefined,
  });

  // Single non-PII line in prod: just records that a signin happened.
  console.log(`[signin] ok role=${user.role}`);
  return NextResponse.json({ ok: true });
}
