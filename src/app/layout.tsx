import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  // Base absoluta para que las URLs relativas (og:image, etc.) se resuelvan
  // a la URL pública. WhatsApp / iMessage / Twitter las necesitan absolutas
  // para poder hacer fetch y mostrar la tarjeta de preview.
  metadataBase: new URL("https://protocol-gen.stacklabs.life"),
  title: "Peptides4ALL – Protocolos",
  description: "Generador de protocolos de administración de péptidos",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Protocolos",
  },
  openGraph: {
    title: "Peptides4ALL – Protocolos",
    description: "Generador de protocolos personalizados de péptidos",
    url: "https://protocol-gen.stacklabs.life",
    siteName: "Peptides4ALL",
    locale: "es_MX",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Peptides4ALL — Generador de protocolos",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Peptides4ALL – Protocolos",
    description: "Generador de protocolos personalizados de péptidos",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#d9943f",
  width: "device-width",
  initialScale: 1,
  // Antes estaba en `maximumScale: 1` para "look de app", pero eso bloquea
  // pinch-zoom en TODA la app, incluyendo la vista previa del PDF dentro del
  // iframe — donde el doctor SÍ necesita poder hacer zoom para revisar
  // dosis y números chicos antes de guardar.
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${dmSans.variable} h-full antialiased`}>
      <head>
        {/* Next.js convention: src/app/icon.png and src/app/apple-icon.png
            generate <link rel="icon"> and <link rel="apple-touch-icon">
            automatically — no need to hand-write them here. */}
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        {children}
      </body>
    </html>
  );
}
