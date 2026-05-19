import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  // Crítico: NO bundlear estos paquetes dentro del serverless function de
  // Vercel. Tienen que cargarse como Node modules externos para que el
  // binario de Chromium pueda ser localizado en disco al runtime. Sin esto,
  // /api/pdf devuelve 500 en producción.
  serverExternalPackages: [
    "@sparticuz/chromium",
    "puppeteer-core",
    "puppeteer",
  ],
  // Y además: decirle a Vercel que SÍ incluya el binario y los archivos
  // .br de @sparticuz/chromium en el bundle de la función. Sin esto,
  // serverExternalPackages evita que se compile pero el dir
  // node_modules/@sparticuz/chromium/bin queda fuera del deploy y se
  // produce "The input directory ... does not exist".
  outputFileTracingIncludes: {
    "/api/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
