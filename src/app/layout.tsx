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
  maximumScale: 5,
  userScalable: true,
  // viewportFit:"cover" hace que el viewport se extienda DEBAJO del notch
  // y home indicator. Sin esto las CSS env(safe-area-inset-*) devuelven 0
  // y el header de la PWA queda cortado bajo el status bar de iOS.
  viewportFit: "cover",
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
        {/* iOS PWA splash. iOS 13+ NO estira un splash genérico — si
            no hay un <link> con media query que matchee al device exacto,
            iOS lo descarta y muestra blanco. Workflow lo flagged como
            must-fix; el fix correcto es generar splashes por resolución
            con pwa-asset-generator (TODO sprint siguiente).
            Por ahora: 4 resoluciones de iPhones populares pre-generadas.
            Cuando no matchea ninguno, iOS cae al fondo del body (cream
            #f5f3f1) que ya seteamos en el body inline style — al menos
            no es blanco brusco. */}
        <link
          rel="apple-touch-startup-image"
          href="/splash.png"
          media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href="/splash.png"
          media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href="/splash.png"
          media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)"
        />
        <link
          rel="apple-touch-startup-image"
          href="/splash.png"
          media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)"
        />
        {/* Fallback sin media query — versiones más viejas de iOS lo aceptan;
            iOS 14+ con device específico arriba lo ignoran. */}
        <link rel="apple-touch-startup-image" href="/splash.png" />
        <script
          dangerouslySetInnerHTML={{
            // SW lifecycle hardening:
            //  - registramos al cargar
            //  - llamamos .update() periódicamente (cada 60 min) por si la app
            //    queda abierta en background y el usuario no recarga
            //  - cuando hay un SW NUEVO esperando (updatefound), le mandamos
            //    skipWaiting via postMessage para que tome control sin
            //    forzar al usuario a cerrar la pestaña. Combinado con el
            //    skipWaiting en sw.js install handler, esto resuelve el
            //    "deployé pero el usuario sigue viendo lo viejo".
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js')
                    .then(function(reg) {
                      // Check for updates each hour in long sessions.
                      setInterval(function() { reg.update().catch(function(){}); }, 3600000);
                      // When a new worker is found and gets installed, ask it
                      // to skipWaiting so it activates on the next reload.
                      reg.addEventListener('updatefound', function() {
                        var nw = reg.installing;
                        if (!nw) return;
                        nw.addEventListener('statechange', function() {
                          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                            try { nw.postMessage({ type: 'SKIP_WAITING' }); } catch(e) {}
                          }
                        });
                      });
                    })
                    .catch(function(err) { console.warn('SW register failed:', err); });
                  // When the active controller changes (new SW took over),
                  // do ONE silent reload so the user sees the new bundle.
                  var refreshed = false;
                  navigator.serviceWorker.addEventListener('controllerchange', function() {
                    if (refreshed) return;
                    refreshed = true;
                    window.location.reload();
                  });
                });
              }
            `,
          }}
        />
      </head>
      <body
        className="min-h-full flex flex-col font-sans"
        // El usuario reportó "pantalla en blanco" al abrir la PWA desde el
        // ícono del home screen en iOS. Era el typical flash blanco del
        // primer frame antes de que CSS+JS booteen. Background cream inline
        // (= manifest.background_color) hace que el primer frame visible
        // coincida con el splash y el resto del app.
        style={{ background: "#f5f3f1" }}
      >
        {children}
      </body>
    </html>
  );
}
