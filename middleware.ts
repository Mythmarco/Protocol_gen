import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLogin = pathname.startsWith("/login");
  const isAuthApi = pathname.startsWith("/api/auth");

  // Don't gate the login page or auth API
  if (isAuthApi) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  if (!session && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (session && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Excluir:
    //   - assets internos de Next (/_next/static, /_next/image)
    //   - cualquier archivo con extensión estática (png, svg, ico, json, etc.)
    //     en el root o subcarpetas. Esto cubre /og-image.png, /sw.js,
    //     /manifest.json, /icons/*, /peptides-logo.svg, etc., sin tener que
    //     listarlos uno por uno. Sin esto, scrapers como WhatsApp / iMessage
    //     pidiendo la OG image son redirigidos a /login.
    "/((?!_next/static|_next/image|.*\\.(?:png|jpe?g|gif|svg|webp|ico|json|js|txt|xml|woff2?|mp4)$).*)",
  ],
};
