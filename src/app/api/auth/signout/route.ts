import { NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

// Origin check para defense-in-depth contra CSRF de signout. Sin esto un
// atacante podía crear una página externa con un form POST a signout y
// forzar al doctor a cerrar sesión silenciosamente (no roba la sesión,
// solo la rompe — pero molesta). Workflow item 5 — completa el fix de
// signin del block 5.
const ALLOWED_ORIGINS = (() => {
  const envList = (process.env.AUTH_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envList.length === 0 && process.env.NODE_ENV !== "production") {
    return ["http://localhost:3000", "http://127.0.0.1:3000"];
  }
  return envList;
})();

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`[signout] rejected origin=${origin}`);
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  await destroySession();
  return NextResponse.json({ ok: true });
}
