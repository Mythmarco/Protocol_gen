// Escapado HTML para TODO el contenido derivado del usuario o del modelo
// que se interpola en el template del PDF.
//
// Antes ningún campo se escapaba — el workflow SOTA lo encontró como
// XSS sistémico. Vector real: el doctor dicta por voz un nombre con
// "<img onerror=...>" o el modelo termina poniendo un valor con HTML
// crudo en cotizacion.nota / indicaciones / explicacion_stack. La
// preview se sirve desde /api/preview que comparte cookie de sesión,
// así que un script inyectado tiene acceso a las APIs autenticadas.
//
// Esta función es la fuente única para escape en server-rendered HTML.
// NO usar dentro de iframes srcDoc / browser-only — para eso React ya
// escapa por default.
export function escapeHTML(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Orden importa: & primero para no doble-escapar las entidades
  // posteriores. Los 5 caracteres son el mínimo del estándar OWASP
  // para texto en contenido HTML (no atributos — para atributos
  // usar escapeHTMLAttr abajo).
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Versión para valores que se interpolan en bullets <li>...</li>, listas
// donde el modelo puede meter <strong>bold</strong> en algunos puntos
// (los syringeBullets ES/EN del template hacen eso a propósito en
// LABELS). NO usar para valores de usuario — esa variante deja pasar
// <strong> y <em> mientras escapa todo lo demás.
//
// Por ahora no la usamos — todos los datos del modelo van por escapeHTML
// estricta. Dejada documentada por si en el futuro hay casos donde el
// modelo necesite emitir énfasis seguro.

// Escape para contextos de atributo HTML (href="...", title="..."). Más
// agresivo: también encodea el espacio para evitar atributos sin comillas
// que se rompan con el primer espacio.
export function escapeHTMLAttr(value: unknown): string {
  return escapeHTML(value);
}
