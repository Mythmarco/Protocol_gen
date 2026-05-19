import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Peptides4ALL – Protocolos",
  description: "Generador de protocolos de administración de péptidos",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Protocolos",
  },
};

export const viewport: Viewport = {
  themeColor: "#d9943f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
      <body className="min-h-full flex flex-col font-[var(--font-dm-sans)]">
        {children}
      </body>
    </html>
  );
}
