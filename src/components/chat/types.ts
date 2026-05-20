// Shared types between ChatPage and its sub-components.
// HistoryItem lives here so MobileHistoryScreen + LandingHero can import
// it without re-declaring or creating a cycle with ChatPage.

export interface HistoryItem {
  id: string;
  paciente_nombre: string;
  descripcion: string;
  fecha_creacion: string;
}
