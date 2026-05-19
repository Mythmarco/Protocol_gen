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
};

export default nextConfig;
