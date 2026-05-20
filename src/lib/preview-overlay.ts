// Inyecta un botón flotante "Cerrar" en el HTML de la vista previa que
// abrimos en una pestaña nueva en móvil. El usuario lo toca y vuelve al
// PWA. Usa window.close() — funciona porque el tab fue creado con
// window.open() desde mismo origen.
//
// Vive en /lib porque lo usan: ChatPage (abrir desde botón "Vista previa")
// y VoiceAgent (abrir automáticamente desde el tool execute al terminar
// el handoff). Tener una sola fuente garantiza que el botón se vea igual
// en ambos flujos.
export function injectMobilePreviewCloseButton(html: string): string {
  const overlay = `
<style>
  .p4a-close-bar {
    position: fixed;
    top: env(safe-area-inset-top, 0);
    left: 0;
    right: 0;
    display: flex;
    justify-content: flex-end;
    padding: 14px 18px;
    z-index: 999999;
    pointer-events: none;
  }
  .p4a-close-btn {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    min-height: 50px;
    background: rgba(20,20,20,0.9);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 13px 22px 13px 18px;
    font: 700 17px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: -0.01em;
    box-shadow: 0 10px 24px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.08);
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }
  .p4a-close-btn:active { transform: scale(0.96); background: rgba(0,0,0,0.95); }
  .p4a-close-btn svg { display: block; }
</style>
<div class="p4a-close-bar">
  <button class="p4a-close-btn" onclick="window.close(); setTimeout(function(){ history.back(); }, 60); return false;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    Cerrar
  </button>
</div>`;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${overlay}`);
  }
  return html + overlay;
}
