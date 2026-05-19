import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  // No bundlear puppeteer ni chromium-min dentro del serverless function.
  // chromium-min no trae binario — se descarga al runtime — así que ya
  // NO hace falta outputFileTracingIncludes (el patrón anterior con
  // @sparticuz/chromium fallaba porque Vercel tree-shakeaba los archivos
  // .br del bin/ directory).
  serverExternalPackages: [
    "@sparticuz/chromium-min",
    "puppeteer-core",
    "puppeteer",
  ],
};

export default nextConfig;
