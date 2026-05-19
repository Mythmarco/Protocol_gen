"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROTOCOL_JSON_MARKER, type ProtocoloData } from "@/lib/protocol-types";
import VoiceAgent from "./VoiceAgent";
import AIOrb from "./AIOrb";

interface HistoryItem {
  id: string;
  paciente_nombre: string;
  descripcion: string;
  fecha_creacion: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface VoiceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

// Persisted conversation shape (mode-agnostic): { role, content }[]
type PersistedTurn = { role: "user" | "assistant"; content: string };

function persistedFromMessages(messages: Message[]): PersistedTurn[] {
  // Clean FIRST (strips the JSON marker block), then drop empty turns so
  // we don't end up persisting bubbles whose entire body was just the JSON.
  return messages
    .map((m) => ({ role: m.role, content: cleanDisplayText(m.content) }))
    .filter((m) => m.content.trim().length > 0);
}

function persistedFromVoice(transcript: VoiceTurn[]): PersistedTurn[] {
  return transcript
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, content: t.text }));
}

interface Props {
  user: { email: string; name: string };
  history: HistoryItem[];
}

function extractProtocolJSON(text: string): ProtocoloData | null {
  const parts = text.split(PROTOCOL_JSON_MARKER);
  if (parts.length < 3) return null;
  try {
    return JSON.parse(parts[1].trim()) as ProtocoloData;
  } catch {
    return null;
  }
}

function cleanDisplayText(text: string): string {
  return text.split(PROTOCOL_JSON_MARKER)[0].trim();
}

// Inyecta un botón flotante "Cerrar" en el HTML de la vista previa que
// abrimos en una pestaña nueva en móvil. El usuario lo toca y vuelve al
// PWA. Usa window.close() — funciona porque el tab fue creado con
// window.open() desde mismo origen.
function injectMobilePreviewCloseButton(html: string): string {
  const overlay = `
<style>
  .p4a-close-bar {
    position: fixed;
    top: env(safe-area-inset-top, 0);
    left: 0;
    right: 0;
    display: flex;
    justify-content: flex-end;
    padding: 10px 14px;
    z-index: 999999;
    pointer-events: none;
  }
  .p4a-close-btn {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(20,20,20,0.85);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 9px 16px 9px 12px;
    font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    box-shadow: 0 6px 16px rgba(0,0,0,0.18), 0 0 0 1px rgba(255,255,255,0.08);
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }
  .p4a-close-btn:active { transform: scale(0.96); }
  .p4a-close-btn svg { display: block; }
</style>
<div class="p4a-close-bar">
  <button class="p4a-close-btn" onclick="window.close(); setTimeout(function(){ history.back(); }, 60); return false;">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    Cerrar
  </button>
</div>`;
  // Insertar justo después del <body ...> de apertura. Si por alguna razón
  // no hay <body>, lo pegamos al final como fallback.
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${overlay}`);
  }
  return html + overlay;
}

const THINKING_LABELS: Record<"thinking" | "protocol", string[]> = {
  thinking: [
    "Pensando…",
    "Analizando tu solicitud…",
    "Consultando el catálogo…",
    "Validando datos clínicos…",
    "Procesando…",
  ],
  protocol: [
    "Generando protocolo…",
    "Buscando precios actualizados…",
    "Calculando dosis y unidades de jeringa…",
    "Armando el calendario semanal…",
    "Redactando indicaciones…",
    "Cerrando la cotización…",
    "Casi listo…",
  ],
};

const QUICK_STARTS = [
  "Paciente Diego de la Garza, 87 kg, 1.76 m, 37 años, mes 2 pérdida de peso visceral",
  "Nuevo protocolo mes 1 para Ana López, 68 kg, 1.65 m, 42 años, energía y recuperación",
];

function LandingHero({
  doctorFirstName,
  onPick,
  onQuickStart,
}: {
  doctorFirstName: string;
  onPick: (mode: "text" | "voice") => void;
  onQuickStart: (prompt: string) => void;
}) {
  const today = new Date().toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  // Capitalize the first letter of the weekday so it reads "Lunes, 18 de mayo".
  const dateLabel = today.charAt(0).toUpperCase() + today.slice(1);

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Decorative ambient gradient + blurred orb in the corner.
          Sits behind the content with pointer-events disabled. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 90% -10%, rgba(242,176,86,0.18), transparent 55%), radial-gradient(circle at 0% 100%, rgba(168,168,176,0.18), transparent 50%)",
        }}
      />
      <div className="pointer-events-none absolute -top-16 -right-16 opacity-50 blur-3xl">
        <AIOrb size={260} />
      </div>

      <div
        className="relative h-full flex flex-col items-center justify-center px-6 py-10"
        style={{ animation: "fadeIn 360ms ease-out" }}
      >
        {/* Hero salutation */}
        <div className="text-center mb-10 md:mb-14 max-w-2xl">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-stone-900">
            Hola, <span className="text-amber-600">{doctorFirstName}</span>
          </h1>
          <p className="mt-2 text-sm md:text-base text-stone-500">
            {dateLabel} · ¿Cómo quieres trabajar hoy?
          </p>
        </div>

        {/* Mode cards — tap to enter that mode */}
        <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => onPick("text")}
            className="group relative overflow-hidden rounded-3xl border border-stone-200 bg-white/80 backdrop-blur-sm p-6 md:p-7 text-left shadow-sm hover:shadow-xl hover:border-amber-300 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-300"
          >
            <div
              className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-amber-300 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-hidden
            />
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-stone-900 text-amber-300 flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-stone-900">Modo texto</h2>
                <p className="text-sm text-stone-500 mt-1 leading-snug">
                  Escribe o dicta los datos del paciente. Ideal para protocolos detallados o cuando estás en silencio.
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center text-xs font-medium text-stone-500 group-hover:text-amber-600 transition-colors">
              Empezar
              <svg className="ml-1 transition-transform group-hover:translate-x-1" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </div>
          </button>

          <button
            onClick={() => onPick("voice")}
            className="group relative overflow-hidden rounded-3xl border border-stone-200 bg-white/80 backdrop-blur-sm p-6 md:p-7 text-left shadow-sm hover:shadow-xl hover:border-amber-300 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-300"
          >
            <div
              className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-amber-300 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-hidden
            />
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
                <AIOrb size={48} />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-stone-900">Modo voz</h2>
                <p className="text-sm text-stone-500 mt-1 leading-snug">
                  Conversa con el agente y deja que él arme el protocolo. Más rápido en consulta.
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center text-xs font-medium text-stone-500 group-hover:text-amber-600 transition-colors">
              Empezar
              <svg className="ml-1 transition-transform group-hover:translate-x-1" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </div>
          </button>
        </div>

        {/* Quick-start chips — discreet, only relevant to text mode but
            tapping any of them implicitly picks text. */}
        <div className="mt-10 w-full max-w-3xl">
          <p className="text-xs uppercase tracking-wider text-stone-400 mb-3 text-center">
            O empieza con un ejemplo
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {QUICK_STARTS.map((q) => (
              <button
                key={q}
                onClick={() => onQuickStart(q)}
                className="flex-1 text-left text-xs text-stone-600 bg-white/70 backdrop-blur-sm border border-stone-200 hover:border-amber-300 hover:text-stone-800 rounded-xl px-3.5 py-2.5 transition-all"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Bucket history items into iOS Mail-style date sections so a long list
// becomes scannable. Buckets in this order: Hoy → Ayer → Esta semana →
// {Month Year} for older items, sorted newest-first within each.
function groupHistoryByDate(items: HistoryItem[]): Array<{
  label: string;
  rows: HistoryItem[];
}> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400_000);
  const startOfWeek = new Date(startOfToday);
  // Treat Monday as week start (es-MX convention)
  const dayOffset = (startOfToday.getDay() + 6) % 7;
  startOfWeek.setDate(startOfToday.getDate() - dayOffset);

  const groups = new Map<string, HistoryItem[]>();
  const order: string[] = [];

  const push = (label: string, item: HistoryItem) => {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(item);
  };

  for (const item of items) {
    const d = new Date(item.fecha_creacion);
    if (d >= startOfToday) push("Hoy", item);
    else if (d >= startOfYesterday) push("Ayer", item);
    else if (d >= startOfWeek) push("Esta semana", item);
    else {
      const monthLabel = d
        .toLocaleDateString("es-MX", { month: "long", year: "numeric" })
        .replace(/^./, (c) => c.toUpperCase());
      push(monthLabel, item);
    }
  }

  return order.map((label) => ({ label, rows: groups.get(label)! }));
}

function patientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable amber tint per patient — same color every time their card renders.
const AVATAR_TINTS = [
  "bg-amber-500", "bg-rose-500", "bg-emerald-500", "bg-sky-500",
  "bg-violet-500", "bg-orange-500", "bg-teal-500", "bg-pink-500",
];
function avatarTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length];
}

function MobileHistoryScreen({
  items,
  onClose,
  onPick,
}: {
  items: HistoryItem[];
  onClose: () => void;
  onPick: (item: HistoryItem) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = query.trim()
    ? items.filter((it) =>
        (it.paciente_nombre + " " + it.descripcion)
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : items;
  const sections = groupHistoryByDate(filtered);

  return (
    <div
      className="md:hidden fixed inset-0 z-50 bg-white flex flex-col"
      style={{ animation: "slideUp 240ms cubic-bezier(0.22, 1, 0.36, 1)" }}
    >
      {/* Sticky header */}
      <header className="flex items-center gap-2 px-2 py-3 border-b border-stone-200 bg-white/95 backdrop-blur-md sticky top-0 z-10">
        <button
          onClick={onClose}
          className="flex items-center gap-1 px-2 py-2 rounded-lg active:bg-stone-100 text-amber-600 font-medium"
          aria-label="Cerrar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="text-sm">Atrás</span>
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-base font-semibold text-stone-900">
          Historial
        </h2>
        <div className="ml-auto pr-2">
          {items.length > 0 && (
            <span className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full font-medium">
              {items.length}
            </span>
          )}
        </div>
      </header>

      {/* Search (only if there's enough to search through) */}
      {items.length > 4 && (
        <div className="px-4 pt-3 pb-2 border-b border-stone-100 bg-white">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400"
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar paciente…"
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-stone-100 border border-transparent rounded-xl focus:bg-white focus:border-amber-300 focus:outline-none transition-all"
            />
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto pb-6">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-8 text-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-stone-100 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              </svg>
            </div>
            <p className="text-sm text-stone-600 font-medium">Aún no hay protocolos guardados</p>
            <p className="text-xs text-stone-400 max-w-xs">
              Los protocolos que guardes aparecerán aquí ordenados por fecha.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-sm text-stone-500 mt-12 px-6">
            No hay resultados para <strong>{query}</strong>.
          </div>
        ) : (
          sections.map((section) => (
            <section key={section.label}>
              <div className="px-4 pt-5 pb-1.5 text-[11px] uppercase tracking-wider text-stone-400 font-semibold">
                {section.label}
              </div>
              <ul className="bg-white">
                {section.rows.map((item, idx) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onPick(item)}
                      className="w-full text-left px-4 py-3 flex items-center gap-3 active:bg-stone-100 transition-colors"
                    >
                      <div
                        className={`w-11 h-11 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${avatarTint(item.paciente_nombre)}`}
                      >
                        {patientInitials(item.paciente_nombre)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <div className="text-sm font-semibold text-stone-900 truncate">
                            {item.paciente_nombre}
                          </div>
                          <div className="ml-auto text-[11px] text-stone-400 flex-shrink-0">
                            {new Date(item.fecha_creacion).toLocaleDateString("es-MX", {
                              day: "numeric", month: "short",
                            })}
                          </div>
                        </div>
                        <div className="text-xs text-stone-500 truncate mt-0.5">
                          {item.descripcion}
                        </div>
                      </div>
                      <svg className="text-stone-300 flex-shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                    {idx < section.rows.length - 1 && (
                      <div className="ml-[4.25rem] h-px bg-stone-100" />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function ThinkingIndicator({ phase }: { phase: "thinking" | "protocol" }) {
  const [labelIdx, setLabelIdx] = useState(0);
  const [labelVisible, setLabelVisible] = useState(true);
  const labels = THINKING_LABELS[phase];

  // Cycle the label every ~3s with a quick fade between swaps so the user
  // sees the chat is doing real work even before any text streams.
  useEffect(() => {
    setLabelIdx(0);
    setLabelVisible(true);
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      setLabelVisible(false);
      setTimeout(() => {
        if (cancelled) return;
        setLabelIdx((i) => (i + 1) % labels.length);
        setLabelVisible(true);
      }, 220);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, labels.length]);

  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <div className="flex-shrink-0">
        <AIOrb size={28} />
      </div>
      <span
        className="text-sm text-stone-600 transition-opacity duration-200"
        style={{ opacity: labelVisible ? 1 : 0 }}
      >
        {labels[labelIdx]}
      </span>
    </div>
  );
}

export default function ChatPage({ user, history: initialHistory }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingProtocol, setPendingProtocol] = useState<ProtocoloData | null>(null);
  // When the protocol on screen matches what's already archived in BD/Drive,
  // we keep a snapshot here so we can render an "Archivado" UI instead of
  // "Guardar PDF". Set when loading from history or right after saving;
  // cleared the moment the doctor edits the draft.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    datos_json: ProtocoloData;
    folio: string;
    driveUrl: string | null;
  } | null>(null);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Mobile-only: which bottom sheet is open
  const [mobileSheet, setMobileSheet] = useState<null | "history" | "account">(null);
  // Mode: text (Claude chat) or voice (OpenAI Realtime)
  const [mode, setMode] = useState<"text" | "voice">("text");
  // IDs de protocolos ya vistos por el usuario. Persistido en localStorage.
  // El badge del nav móvil cuenta cuántos protocolos hay en `history` cuyo
  // id NO está aquí — i.e., creados pero no vistos todavía.
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  // Cuando hacemos un swap de vista (landing → mode, history → conversación)
  // bajamos la opacidad un instante para que el cambio se sienta como un
  // cross-fade en vez de un salto brusco. Lo levantamos en el próximo frame.
  const [viewTransition, setViewTransition] = useState(false);
  // Mientras /api/history/[id] está cargando — muestra un overlay sutil con
  // un AIOrb pequeño en lugar de dejar al doctor mirando una pantalla vieja.
  const [loadingProtocolFromHistory, setLoadingProtocolFromHistory] = useState(false);
  // Landing hero — shown right after login as the "how do you want to work
  // today?" picker. Once dismissed, the doctor stays in the working UI for
  // the rest of the session (the header Texto/Voz toggle is the secondary
  // control to switch modes later).
  const [landingShown, setLandingShown] = useState(true);
  // Live voice transcript bubbled up from VoiceAgent — persisted with the PDF
  // so the doctor can reload it and keep talking.
  const [voiceTranscript, setVoiceTranscript] = useState<VoiceTurn[]>([]);
  // Seed for VoiceAgent when restoring a past voice conversation.
  const [voiceSeed, setVoiceSeed] = useState<VoiceTurn[] | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHTML, setPreviewHTML] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  // Toast shown after a successful PDF save (auto-dismisses)
  const [toast, setToast] = useState<{
    folio: string;
    driveUrl: string;
    visible: boolean;
  } | null>(null);
  // Voice
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recError, setRecError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Inicializa seenIds desde localStorage. Si es la primera vez que abrimos
  // la app, marcamos como vistos TODOS los protocolos existentes para que el
  // badge nazca en 0 — solo los protocolos creados después de este momento
  // cuentan como "nuevos".
  useEffect(() => {
    try {
      const stored = typeof window !== "undefined"
        ? window.localStorage.getItem("p4a:seenProtocolIds")
        : null;
      if (stored) {
        setSeenIds(new Set(JSON.parse(stored) as string[]));
      } else {
        const baseline = new Set(initialHistory.map((i) => i.id));
        setSeenIds(baseline);
        window.localStorage.setItem(
          "p4a:seenProtocolIds",
          JSON.stringify([...baseline])
        );
      }
    } catch (err) {
      console.warn("[history] seenIds init failed:", err);
    }
    // Intencional: solo en el primer mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // runViewTransition: baja la opacidad de la vista, espera el fade-out,
  // aplica el cambio de estado, y luego vuelve a opacidad 1. Da la sensación
  // de cross-fade sin requerir framer-motion ni overlays separados.
  const runViewTransition = useCallback((apply: () => void) => {
    setViewTransition(true);
    window.setTimeout(() => {
      apply();
      // Pequeño respiro para que React commita antes de levantar la opacidad
      window.setTimeout(() => setViewTransition(false), 30);
    }, 200);
  }, []);

  const markSeen = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSeenIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (changed) {
        try {
          window.localStorage.setItem(
            "p4a:seenProtocolIds",
            JSON.stringify([...next])
          );
        } catch {}
      }
      return changed ? next : prev;
    });
  }, []);

  const unreadCount = history.reduce(
    (n, it) => (seenIds.has(it.id) ? n : n + 1),
    0
  );

  // Reset del badge cuando el doctor abre el listado:
  //   - móvil: al abrir el sheet "historial"
  //   - desktop: cuando el sidebar está expandido (siempre lo está por
  //     defecto, así que esto cubre la mayoría de los flujos)
  useEffect(() => {
    if (mobileSheet === "history") {
      markSeen(history.map((it) => it.id));
    }
  }, [mobileSheet, history, markSeen]);

  useEffect(() => {
    if (sidebarOpen) {
      markSeen(history.map((it) => it.id));
    }
  }, [sidebarOpen, history, markSeen]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const newMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);
    // Snapshot the current draft BEFORE clearing it so we can send it as
    // edit context. Clearing pendingProtocol hides the action toolbar so the
    // doctor can't click "Guardar" on a stale version while we regenerate.
    const draftForEdit = pendingProtocol;
    setPendingProtocol(null);
    // An edit invalidates the "this is the archived one" state — whatever
    // comes back will be a new draft that needs to be saved.
    setSavedSnapshot(null);

    const assistantMsg: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: cleanDisplayText(m.content),
          })),
          currentDraft: draftForEdit,
        }),
      });

      if (!res.ok) throw new Error("Error en la solicitud");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: fullText };
          return updated;
        });
      }

      const protocol = extractProtocolJSON(fullText);
      if (protocol) {
        setPendingProtocol(protocol);
        // Auto-open preview when a protocol is generated
        openPreview(protocol);
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Hubo un error al generar la respuesta. Intenta de nuevo.",
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Detección barata de "esto es un móvil" — usamos viewport width porque
  // iOS Safari miente con userAgent y `matchMedia('(pointer:coarse)')` no
  // es 100% confiable en simuladores. 768px coincide con el breakpoint
  // md: de Tailwind y es donde aparece el bottom-nav.
  const isMobileViewport = () =>
    typeof window !== "undefined" && window.innerWidth < 768;

  const openPreview = async (protocol: ProtocoloData) => {
    // En móvil, el iframe-modal tiene problemas conocidos con pinch-zoom
    // (iOS Safari ignora el viewport meta dentro de iframes), así que
    // abrimos el HTML como pestaña nativa de Safari donde el zoom funciona.
    // En desktop seguimos con el modal.
    if (isMobileViewport()) {
      // Abrir la pestaña INMEDIATAMENTE — si la abrimos después del await
      // Safari la bloquea como popup (solo permite window.open dentro del
      // gesture-handler de un click).
      const tab = window.open("", "_blank");
      if (tab) {
        tab.document.write(
          '<!doctype html><html><body style="margin:0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;color:#888"><p>Cargando vista previa…</p></body></html>'
        );
      }
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ protocolData: protocol }),
        });
        if (!res.ok) throw new Error("preview failed");
        const html = await res.text();
        if (tab) {
          const htmlWithClose = injectMobilePreviewCloseButton(html);
          tab.document.open();
          tab.document.write(htmlWithClose);
          tab.document.close();
        }
      } catch (err) {
        console.error(err);
        if (tab) {
          tab.document.body.innerHTML =
            "<p style='padding:2rem;font-family:sans-serif'>No se pudo cargar la vista previa.</p>";
        }
      }
      return;
    }

    // Desktop: modal con iframe (zoom no es problema en monitor)
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewHTML("");
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocolData: protocol }),
      });
      if (!res.ok) throw new Error("preview failed");
      const html = await res.text();
      setPreviewHTML(html);
    } catch (err) {
      console.error(err);
      setPreviewHTML("<p style='padding:2rem;font-family:sans-serif'>No se pudo cargar la vista previa.</p>");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownloadPDF = async () => {
    if (!pendingProtocol) return;
    setIsGeneratingPDF(true);
    try {
      // Snapshot whichever conversation produced this protocol so we can
      // restore it later from history and let the doctor keep iterating.
      const conversacion: PersistedTurn[] =
        mode === "voice"
          ? persistedFromVoice(voiceTranscript)
          : persistedFromMessages(messages);
      const conversacion_modo = mode;

      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolData: pendingProtocol,
          conversacion,
          conversacion_modo,
        }),
      });

      if (!res.ok) {
        // Surface the real error so we can debug live issues instead of
        // dumping the user at a useless "make sure the server is running".
        const detail = await res.text().catch(() => "");
        throw new Error(
          `PDF API ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
        );
      }

      // Pull the folio + drive URL from headers we set server-side
      const folio = res.headers.get("X-Folio") || "";
      const driveUrl = res.headers.get("X-Drive-Url") || "";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const nombreSlug = pendingProtocol.paciente.nombre
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      a.href = url;
      a.download = `${folio || nombreSlug}-${pendingProtocol.metadata.fecha}.pdf`;
      a.click();
      URL.revokeObjectURL(url);

      // Show success toast (auto-dismiss after 6s)
      setToast({ folio, driveUrl, visible: true });
      setTimeout(() => setToast((t) => (t ? { ...t, visible: false } : null)), 6000);
      setTimeout(() => setToast(null), 6400); // unmount after fade-out

      // Flip the UI into "archived" mode for this protocol — Guardar PDF
      // becomes Descargar, and the top toolbar hides until the doctor edits.
      setSavedSnapshot({
        datos_json: pendingProtocol,
        folio,
        driveUrl: driveUrl || null,
      });

      // Close the preview modal — user saw it before saving, no need to keep it
      setPreviewOpen(false);

      // Refresh history sidebar
      const histRes = await fetch("/api/history");
      if (histRes.ok) {
        const { items } = (await histRes.json()) as { items: HistoryItem[] };
        setHistory(items);
      }
    } catch (err) {
      console.error(err);
      alert(
        `No se pudo guardar el PDF.\n\n${err instanceof Error ? err.message : "Error desconocido."}\n\nRevisa que las variables de entorno estén configuradas en Vercel.`
      );
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  // Re-download a protocol that is already archived. Calls /api/pdf with
  // mode="download" so it just renders + returns — no new folio, no Drive
  // upload, no duplicate row in Supabase.
  const handleDownloadArchived = async () => {
    if (!savedSnapshot) return;
    setIsDownloading(true);
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolData: savedSnapshot.datos_json,
          mode: "download",
        }),
      });
      if (!res.ok) throw new Error("download failed");

      const folio = res.headers.get("X-Folio") || savedSnapshot.folio || "";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const nombreSlug = savedSnapshot.datos_json.paciente.nombre
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      a.href = url;
      a.download = `${folio || nombreSlug}-${savedSnapshot.datos_json.metadata.fecha}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert("No se pudo descargar el PDF.");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleRegenerate = () => {
    // Clear the current protocol state immediately — the action buttons
    // (Vista previa / Guardar PDF) disappear until a new one is generated.
    // Avoids the user clicking "Guardar" on the stale version.
    setPendingProtocol(null);
    setSavedSnapshot(null);
    setPreviewOpen(false);
    setPreviewHTML("");

    if (mode === "text") {
      // Re-prompt Claude through the composer.
      setInput("Por favor, regenera el protocolo con los mismos datos.");
      // Slight delay so React renders the input first
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      // Voice mode: just clear state. The doctor will tap the mic when ready
      // to dictate the changes. Show a brief assistant message in the
      // (otherwise empty) chat thread so the UX makes sense.
      setMessages([
        {
          role: "assistant",
          content:
            "Protocolo descartado. Toca el micrófono para dictarme los cambios o vuelve a empezar.",
        },
      ]);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/login";
  };

  const handleNewChat = () => {
    setMessages([]);
    setPendingProtocol(null);
    setSavedSnapshot(null);
    setInput("");
    setVoiceTranscript([]);
    setVoiceSeed(undefined);
  };

  // ── Voice recording (Whisper via /api/transcribe) ──
  const startRecording = async () => {
    setRecError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecError("Tu navegador no soporta grabación de audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;

      // Pick the best supported mime type
      const preferredTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        recStreamRef.current?.getTracks().forEach((t) => t.stop());
        recStreamRef.current = null;
        const blob = new Blob(recChunksRef.current, { type: mimeType || "audio/webm" });
        setRecState("transcribing");
        try {
          const form = new FormData();
          form.append("audio", blob, "recording.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error ?? "transcription failed");
          }
          const { text } = (await res.json()) as { text: string };
          if (text) {
            // Append to existing input (don't replace) so doctor can keep adding
            setInput((prev) => (prev ? `${prev.trim()} ${text}` : text));
            // Auto-resize the textarea
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 288) + "px";
                el.focus();
              }
            });
          }
        } catch (err) {
          console.error(err);
          setRecError(err instanceof Error ? err.message : "Error al transcribir");
        } finally {
          setRecState("idle");
        }
      };
      recorder.start();
      recRef.current = recorder;
      setRecState("recording");
    } catch (err) {
      console.error(err);
      setRecError("No se pudo acceder al micrófono. Revisa permisos del navegador.");
      setRecState("idle");
    }
  };

  const stopRecording = () => {
    if (recRef.current && recRef.current.state !== "inactive") {
      recRef.current.stop();
    }
  };

  const toggleRecording = () => {
    if (recState === "recording") stopRecording();
    else if (recState === "idle") startRecording();
  };

  const handleLoadHistory = async (item: HistoryItem) => {
    // Mostrar overlay de carga + cerrar el sheet móvil de inmediato para
    // que el doctor vea acción al instante en lugar de mirar la lista.
    setLoadingProtocolFromHistory(true);
    setMobileSheet(null);
    let payload: {
      datos_json: ProtocoloData;
      conversacion?: PersistedTurn[];
      conversacion_modo?: "text" | "voice";
      folio?: string | null;
      drive_url?: string | null;
    } | null = null;
    try {
      const res = await fetch(`/api/history/${item.id}`);
      if (!res.ok) return;
      payload = await res.json();
    } catch (err) {
      console.error("[history] load failed:", err);
      return;
    } finally {
      // Si la fetch terminó muy rápido (cache), aún queremos al menos un
      // mínimo perceptible de animación. Si no, el "Cargando…" parpadea feo.
    }
    if (!payload?.datos_json) {
      setLoadingProtocolFromHistory(false);
      return;
    }
    const {
      datos_json,
      conversacion,
      conversacion_modo,
      folio,
      drive_url,
    } = payload;

    // Cross-fade hacia la conversación cargada: opacidad baja → aplicar
    // estado → opacidad sube. Y al final levantamos el overlay de carga.
    runViewTransition(() => {
      setLandingShown(false);
      markSeen([item.id]);
      setPendingProtocol(datos_json);
      setSavedSnapshot({
        datos_json,
        folio: folio || datos_json.cotizacion?.folio || "",
        driveUrl: drive_url ?? null,
      });

      const turns = Array.isArray(conversacion) ? conversacion : [];
      const restoredMode: "text" | "voice" =
        conversacion_modo === "voice" ? "voice" : "text";
      setMode(restoredMode);

      const bannerText = `Protocolo cargado: **${item.paciente_nombre}** — ${item.descripcion}\n\n¿Qué deseas modificar o necesitas generar el PDF?`;
      const banner: Message = {
        role: "assistant",
        content: `${bannerText}\n\n${PROTOCOL_JSON_MARKER}\n${JSON.stringify(datos_json)}\n${PROTOCOL_JSON_MARKER}`,
      };

      if (restoredMode === "voice") {
        const seed: VoiceTurn[] = turns.map((t, i) => ({
          id: `seed-${i}`,
          role: t.role,
          text: t.content,
        }));
        setVoiceSeed(seed);
        setVoiceTranscript(seed);
        setMessages([]);
      } else {
        const restored: Message[] = turns.map((t) => ({
          role: t.role,
          content: t.content,
        }));
        setMessages(restored.length > 0 ? [...restored, banner] : [banner]);
        setVoiceSeed(undefined);
        setVoiceTranscript([]);
      }
    });

    // Apagar el overlay cuando termine la transición visual.
    window.setTimeout(() => setLoadingProtocolFromHistory(false), 280);
  };

  return (
    <div className="flex h-screen bg-stone-50 font-sans overflow-hidden">
      {/* Sidebar (desktop only — mobile uses bottom nav) */}
      <aside
        className={`hidden md:flex flex-col bg-stone-900 text-stone-100 transition-all duration-300 ${
          sidebarOpen ? "w-72" : "w-0"
        } overflow-hidden flex-shrink-0`}
      >
        <div className="p-4 flex items-center justify-between border-b border-stone-700">
          <div>
            <div className="text-sm font-bold text-amber-400">Peptides4ALL</div>
            <div className="text-xs text-stone-400">Generador de Protocolos</div>
          </div>
          <button
            onClick={handleNewChat}
            className="text-xs bg-amber-500 hover:bg-amber-400 text-white rounded-lg px-3 py-1.5 font-medium transition-colors"
          >
            + Nuevo
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {history.length === 0 ? (
            <p className="text-xs text-stone-500 text-center mt-8 px-4">
              Los protocolos guardados aparecerán aquí.
            </p>
          ) : (
            <div className="space-y-1">
              {history.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleLoadHistory(item)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-stone-800 transition-colors group"
                >
                  <div className="text-sm font-medium text-stone-200 truncate">
                    {item.paciente_nombre}
                  </div>
                  <div className="text-xs text-stone-500 truncate mt-0.5">
                    {item.descripcion}
                  </div>
                  <div className="text-xs text-stone-600 mt-0.5">
                    {new Date(item.fecha_creacion).toLocaleDateString("es-MX")}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-stone-700">
          <div className="text-xs text-stone-400 truncate mb-2">{user.email}</div>
          <button
            onClick={handleSignOut}
            className="text-xs text-stone-500 hover:text-stone-300 transition-colors"
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-stone-200">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="hidden md:block p-1.5 rounded-lg hover:bg-stone-100 transition-colors text-stone-500"
            title="Toggle sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          <button
            onClick={() => {
              // Click en el logo = regresar a la landing.
              // No borramos messages ni pendingProtocol — la landing aparece
              // por encima y al elegir un modo el doctor vuelve a lo que tenía.
              runViewTransition(() => setLandingShown(true));
            }}
            className="flex items-center rounded-lg active:opacity-70 transition-opacity"
            title="Volver al inicio"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/peptides-logo.svg"
              alt="Peptides4ALL"
              className="h-7 md:h-8 w-auto"
            />
          </button>
          <span className="hidden lg:inline text-xs text-stone-400 border-l border-stone-200 pl-3 ml-1">
            Generador de Protocolos
          </span>

          {/* Mode toggle: Texto / Voz */}
          <div className="flex items-center bg-stone-100 rounded-lg p-0.5 ml-1 md:ml-3">
            <button
              onClick={() => setMode("text")}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 ${
                mode === "text" ? "bg-white text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-700"
              }`}
              title="Modo texto (Claude)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="hidden sm:inline">Texto</span>
            </button>
            <button
              onClick={() => setMode("voice")}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 ${
                mode === "voice" ? "bg-white text-amber-600 shadow-sm" : "text-stone-500 hover:text-stone-700"
              }`}
              title="Modo voz (GPT Realtime)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                <line x1="12" y1="18" x2="12" y2="22"/>
              </svg>
              <span className="hidden sm:inline">Voz</span>
            </button>
          </div>

          {/* Right side: greeting only (action buttons moved to secondary toolbar below) */}
          <div className="ml-auto flex items-center gap-1 text-xs md:text-sm text-stone-600 pl-2 md:pl-3 md:border-l md:border-stone-200 whitespace-nowrap">
            <span>Hola,</span>
            <strong className="text-stone-800 truncate max-w-[100px] md:max-w-none">
              {(user.name || user.email.split("@")[0]).split(" ")[0]}
            </strong>
          </div>
        </header>

        {/* Action toolbar — only for UNSAVED drafts. When the on-screen
             protocol is already archived (loaded from history or just saved),
             we hide the toolbar entirely and surface the "Descargar / Abrir
             en Drive" actions inline under the last assistant message. */}
        {pendingProtocol && savedSnapshot?.datos_json !== pendingProtocol && (
          <div className="bg-amber-50/60 border-b border-amber-100 px-3 py-2 flex items-center gap-2 overflow-x-auto">
            <span className="flex items-center gap-1.5 text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-semibold whitespace-nowrap flex-shrink-0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Protocolo listo
            </span>
            <div className="flex-1" />
            <button
              onClick={handleRegenerate}
              disabled={isStreaming}
              className="flex items-center gap-1.5 text-xs border border-stone-300 hover:border-amber-400 bg-white text-stone-700 hover:text-amber-700 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap flex-shrink-0"
              title="Pedir al asistente que regenere"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span className="hidden sm:inline">Regenerar</span>
            </button>
            <button
              onClick={() => openPreview(pendingProtocol)}
              className="flex items-center gap-1.5 text-xs border border-stone-300 hover:border-amber-400 bg-white text-stone-700 hover:text-amber-700 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap flex-shrink-0"
              title="Ver el PDF antes de guardar"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
              </svg>
              <span className="hidden sm:inline">Vista previa</span>
            </button>
            <button
              onClick={handleDownloadPDF}
              disabled={isGeneratingPDF}
              className="flex items-center gap-1.5 text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white rounded-lg px-3.5 py-1.5 font-semibold transition-colors shadow-sm whitespace-nowrap flex-shrink-0"
              title="Generar y descargar el PDF + subir a Drive"
            >
              {isGeneratingPDF ? (
                <>
                  <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>Guardando…</span>
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Guardar PDF
                </>
              )}
            </button>
          </div>
        )}

        {/* View swap wrapper — landing, voice y text mode comparten esta
             caja para poder cross-fade entre ellos sin reflow brusco. */}
        <div
          className="relative flex flex-col flex-1 min-h-0"
          style={{
            opacity: viewTransition ? 0 : 1,
            transition: "opacity 200ms ease-out",
          }}
        >
        {/* Overlay sutil de carga mientras /api/history/[id] termina. */}
        {loadingProtocolFromHistory && (
          <div
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-stone-50/85 backdrop-blur-sm"
            style={{ animation: "fadeIn 180ms ease-out" }}
          >
            <AIOrb size={56} />
            <p className="text-sm text-stone-600 font-medium">
              Abriendo protocolo…
            </p>
          </div>
        )}

        {/* Landing hero — first-impression picker after login. Hides as
             soon as the doctor picks a mode (taps a card or a quick-start). */}
        {landingShown && (
          <LandingHero
            doctorFirstName={(user.name || user.email.split("@")[0]).split(/\s+/)[0]}
            onPick={(picked) => {
              runViewTransition(() => {
                setMode(picked);
                setLandingShown(false);
              });
              if (picked === "text") {
                window.setTimeout(() => textareaRef.current?.focus(), 260);
              }
            }}
            onQuickStart={(prompt) => {
              runViewTransition(() => {
                setMode("text");
                setLandingShown(false);
                setInput(prompt);
              });
              window.setTimeout(() => textareaRef.current?.focus(), 260);
            }}
          />
        )}

        {/* Voice mode takes over the whole work area */}
        {!landingShown && mode === "voice" && (
          <div
            className="flex flex-col flex-1 min-h-0"
            style={{ animation: "fadeIn 280ms ease-out" }}
          >
            <VoiceAgent
              // First name only — full name sounds awkward in voice ("Hola Marco Saenz Lopez...")
              doctorName={(user.name || user.email.split("@")[0]).split(/\s+/)[0]}
              onProtocolGenerated={(data) => {
                setPendingProtocol(data);
                openPreview(data);
              }}
              onTranscriptChange={setVoiceTranscript}
              initialTranscript={voiceSeed}
            />
          </div>
        )}

        {/* Text mode: messages + composer */}
        {!landingShown && mode === "text" && (
        <>
        {/* Messages */}
        <div
          className="flex-1 overflow-y-auto px-4 py-6 space-y-4"
          style={{ animation: "fadeIn 280ms ease-out" }}
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 max-w-md mx-auto">
              <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d9943f" strokeWidth="1.8">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <div>
                <p className="font-semibold text-stone-700 mb-1">Listo para generar un protocolo</p>
                <p className="text-sm text-stone-500">
                  Dime los datos del paciente: nombre, peso, estatura, edad y el objetivo clínico. Yo te pregunto si falta algo.
                </p>
              </div>
              <div className="flex flex-col gap-2 w-full">
                {[
                  "Paciente Diego de la Garza, 87 kg, 1.76 m, 37 años, mes 2 pérdida de peso visceral",
                  "Nuevo protocolo mes 1 para Ana López, 68 kg, 1.65 m, 42 años, energía y recuperación",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="text-left text-sm bg-white border border-stone-200 hover:border-amber-400 rounded-xl px-4 py-2.5 text-stone-600 hover:text-stone-800 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            const isAssistant = msg.role === "assistant";
            const hasJsonMarker = msg.content.includes(PROTOCOL_JSON_MARKER);
            const protocol = extractProtocolJSON(msg.content);
            const cleanText = isAssistant ? cleanDisplayText(msg.content) : msg.content;

            // While streaming a protocol response, hide all text and show a loader.
            // The pre-JSON text becomes irrelevant — the PDF preview is what matters.
            const showProtocolLoader =
              isAssistant && isLast && isStreaming && hasJsonMarker && !protocol;

            const showQuestionLoader =
              isAssistant && isLast && isStreaming && !hasJsonMarker && cleanText.length === 0;

            // Skip empty assistant bubbles entirely (e.g. legacy saved turns
            // whose content was nothing but a JSON marker block). Don't skip
            // when streaming — the empty placeholder is how we show loaders.
            if (
              isAssistant &&
              !isStreaming &&
              cleanText.length === 0 &&
              !protocol
            ) {
              return null;
            }

            return (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-2xl rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-amber-500 text-white rounded-br-sm whitespace-pre-wrap"
                      : "bg-white border border-stone-200 text-stone-800 rounded-bl-sm shadow-sm"
                  }`}
                >
                  {showQuestionLoader ? (
                    <ThinkingIndicator phase="thinking" />
                  ) : showProtocolLoader ? (
                    <ThinkingIndicator phase="protocol" />
                  ) : isAssistant ? (
                    <div className="prose prose-sm prose-stone max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0 prose-headings:my-2 prose-table:my-2 prose-table:text-xs prose-th:bg-stone-50 prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-table:border prose-table:border-stone-200 prose-th:border prose-th:border-stone-200 prose-td:border prose-td:border-stone-200 prose-code:bg-stone-100 prose-code:px-1 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanText}</ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{cleanText}</span>
                  )}

                  {isAssistant && protocol && (() => {
                    // Treat this inline card as "archived" if it points to
                    // the same protocol object that's currently saved. Then
                    // Guardar PDF → Descargar, and we add an "Abrir en Drive"
                    // link when we have one.
                    const isArchived =
                      savedSnapshot != null &&
                      savedSnapshot.datos_json === protocol;
                    return (
                      <div className="mt-3 pt-3 border-t border-stone-100 flex flex-wrap items-center gap-2">
                        {isArchived ? (
                          <span
                            className="flex items-center gap-1 text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full font-medium"
                            title={
                              savedSnapshot?.folio
                                ? `Folio ${savedSnapshot.folio} guardado en Drive`
                                : "Guardado en Drive"
                            }
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Archivado{savedSnapshot?.folio ? ` · ${savedSnapshot.folio}` : ""}
                          </span>
                        ) : (
                          <span className="text-xs text-green-600 font-medium">
                            ✓ Protocolo generado
                          </span>
                        )}

                        <div className="ml-auto flex items-center gap-2">
                          <button
                            onClick={() => openPreview(protocol)}
                            className="text-xs border border-stone-300 hover:border-amber-400 text-stone-600 hover:text-amber-600 rounded-lg px-2.5 py-1 font-medium transition-colors"
                          >
                            Vista previa
                          </button>

                          {isArchived ? (
                            <>
                              {savedSnapshot?.driveUrl && (
                                <a
                                  href={savedSnapshot.driveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs border border-stone-300 hover:border-amber-400 text-stone-600 hover:text-amber-600 rounded-lg px-2.5 py-1 font-medium transition-colors"
                                >
                                  Abrir en Drive
                                </a>
                              )}
                              <button
                                onClick={handleDownloadArchived}
                                disabled={isDownloading}
                                className="text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white rounded-lg px-2.5 py-1 font-medium transition-colors"
                              >
                                {isDownloading ? "Descargando…" : "Descargar"}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={handleDownloadPDF}
                              disabled={isGeneratingPDF}
                              className="text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white rounded-lg px-2.5 py-1 font-medium transition-colors"
                            >
                              {isGeneratingPDF ? "Guardando…" : "Guardar PDF"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>

        {/* Input area — Claude/ChatGPT-style composer */}
        <div className="border-t border-stone-200 bg-white px-3 md:px-6 py-3 md:py-4">
          <div className="max-w-3xl mx-auto">
            <div className="relative flex items-end rounded-2xl border border-stone-300 bg-white shadow-sm focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-100 transition-all">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  recState === "recording"
                    ? "Grabando… habla y luego toca el botón para detener"
                    : recState === "transcribing"
                    ? "Transcribiendo audio…"
                    : "Escribe o dicta los datos del paciente…"
                }
                rows={2}
                disabled={recState !== "idle"}
                className="flex-1 resize-none bg-transparent rounded-2xl px-4 py-3.5 md:py-4 text-base text-stone-800 placeholder-stone-400 focus:outline-none max-h-72 overflow-y-auto min-h-[60px] md:min-h-[72px] pr-24 disabled:opacity-70"
                style={{ lineHeight: "1.55" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 288) + "px";
                }}
              />

              {/* Mic button */}
              <button
                onClick={toggleRecording}
                disabled={recState === "transcribing" || isStreaming}
                className={`absolute right-14 bottom-2 flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all shadow-sm
                  ${
                    recState === "recording"
                      ? "bg-red-500 hover:bg-red-400 text-white animate-pulse"
                      : recState === "transcribing"
                      ? "bg-stone-200 text-stone-500"
                      : "bg-stone-100 hover:bg-stone-200 text-stone-600"
                  } disabled:opacity-50`}
                title={
                  recState === "recording"
                    ? "Detener grabación"
                    : recState === "transcribing"
                    ? "Transcribiendo…"
                    : "Dictar por voz"
                }
              >
                {recState === "transcribing" ? (
                  <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                ) : recState === "recording" ? (
                  // Stop icon (square)
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2"/>
                  </svg>
                ) : (
                  // Microphone icon
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                    <line x1="12" y1="18" x2="12" y2="22"/>
                    <line x1="8" y1="22" x2="16" y2="22"/>
                  </svg>
                )}
              </button>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={isStreaming || !input.trim() || recState !== "idle"}
                className="absolute right-2 bottom-2 flex-shrink-0 w-10 h-10 bg-amber-500 hover:bg-amber-400 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center transition-all shadow-sm"
                title="Enviar (Enter)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
              </button>
            </div>

            {recError && (
              <p className="text-xs text-red-600 text-center mt-2">{recError}</p>
            )}

            <p className="text-xs text-stone-400 text-center mt-2 hidden md:block">
              <kbd className="px-1.5 py-0.5 bg-stone-100 border border-stone-200 rounded text-[10px]">Enter</kbd> para enviar · <kbd className="px-1.5 py-0.5 bg-stone-100 border border-stone-200 rounded text-[10px]">Shift+Enter</kbd> para nueva línea · 🎤 dictar por voz
            </p>
          </div>
        </div>
        </>
        )}
        </div>
        {/* /view swap wrapper */}

        {/* Bottom nav (mobile only) */}
        <nav className="md:hidden flex items-center justify-around bg-white border-t border-stone-200 px-2 py-2 safe-area-inset-bottom">
          <button
            onClick={handleNewChat}
            className="flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-lg active:bg-stone-100 transition-colors"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d9943f" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="text-[10px] font-medium text-stone-600">Nuevo</span>
          </button>
          <button
            onClick={() => setMobileSheet("history")}
            className="flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-lg active:bg-stone-100 transition-colors relative"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#504d4d" strokeWidth="2">
              <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
            </svg>
            <span className="text-[10px] font-medium text-stone-600">Historial</span>
            {unreadCount > 0 && (
              <span className="absolute top-0 right-2 bg-amber-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setMobileSheet("account")}
            className="flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-lg active:bg-stone-100 transition-colors"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#504d4d" strokeWidth="2">
              <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
            <span className="text-[10px] font-medium text-stone-600">Cuenta</span>
          </button>
        </nav>
      </div>

      {/* Mobile: Historial → full-screen page (iOS-style).
           Why full-screen instead of bottom sheet: at 80vh, taps near the
           bottom row collided with the mobile bottom nav and felt broken.
           A full-screen view also gives room for date sections + search. */}
      {mobileSheet === "history" && (
        <MobileHistoryScreen
          items={history}
          onClose={() => setMobileSheet(null)}
          onPick={(item) => {
            handleLoadHistory(item);
            setMobileSheet(null);
          }}
        />
      )}

      {/* Mobile: Cuenta stays as a small bottom sheet — it's a tiny menu. */}
      {mobileSheet === "account" && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 flex items-end"
          onClick={() => setMobileSheet(null)}
        >
          <div
            className="w-full bg-white rounded-t-2xl max-h-[80vh] flex flex-col animate-[slideUp_0.2s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
              <h3 className="text-sm font-semibold text-stone-700">Cuenta</h3>
              <button
                onClick={() => setMobileSheet(null)}
                className="p-1 rounded-lg hover:bg-stone-100 text-stone-500"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-5 flex flex-col gap-3">
              <div>
                <div className="text-xs text-stone-500 uppercase tracking-wider mb-1">Sesión</div>
                <div className="text-sm text-stone-800 break-all">{user.email}</div>
              </div>
              <button
                onClick={handleSignOut}
                className="mt-2 w-full bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl py-3 text-sm font-medium transition-colors"
              >
                Cerrar sesión
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save-success toast (top-center, auto-dismisses) */}
      {toast && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
          style={{
            opacity: toast.visible ? 1 : 0,
            transform: `translateX(-50%) translateY(${toast.visible ? 0 : -8}px)`,
            transition: "opacity 350ms ease-out, transform 350ms ease-out",
          }}
        >
          <div className="bg-stone-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 max-w-md pointer-events-auto">
            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="flex-1 text-sm">
              <div className="font-semibold">
                Protocolo guardado · {toast.folio || "—"}
              </div>
              <div className="text-xs text-stone-300">
                Registrado en la base y descargado.{" "}
                {toast.driveUrl && (
                  <a
                    href={toast.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-amber-300"
                  >
                    Abrir en Drive
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal — smooth fade-in + skeleton page while iframe loads */}
      {previewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex flex-col"
          style={{ animation: "fadeIn 220ms ease-out" }}
        >
          <div className="bg-white border-b border-stone-200 px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-semibold text-stone-700">
              Vista previa del protocolo
            </span>
            <span className="text-xs text-stone-500 hidden sm:inline">
              Así se verá el PDF
            </span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => setPreviewOpen(false)}
                className="text-xs border border-stone-300 hover:border-stone-400 text-stone-600 rounded-lg px-3 py-1.5 transition-colors"
              >
                Cerrar
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={isGeneratingPDF}
                className="text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white rounded-lg px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5"
              >
                {isGeneratingPDF ? (
                  <>
                    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    Guardando…
                  </>
                ) : (
                  <>Guardar PDF</>
                )}
              </button>
            </div>
          </div>
          <div
            className="flex-1 bg-stone-100 relative overflow-auto"
            style={{
              // Permitir pan + pinch-zoom nativo del parent en iOS Safari.
              // (En el iframe interno iOS ignora el viewport meta — así que
              // dejamos que el iframe sea ancho fijo de A4 y el contenedor
              // hace el scroll/pinch.)
              WebkitOverflowScrolling: "touch",
              touchAction: "pan-x pan-y pinch-zoom",
            }}
          >
            {/* Skeleton paper while iframe loads */}
            {previewLoading && (
              <div className="absolute inset-0 flex items-start justify-center pt-8 px-4 overflow-hidden pointer-events-none">
                <div
                  className="w-full max-w-2xl bg-white shadow-xl rounded-md p-8 space-y-3"
                  style={{ animation: "scaleIn 200ms ease-out both" }}
                >
                  <div className="h-8 w-1/3 rounded bg-gradient-to-r from-stone-200 via-stone-100 to-stone-200 bg-[length:200%_100%]" style={{ animation: "shimmer 1.4s linear infinite" }} />
                  <div className="h-3 w-2/3 rounded bg-stone-200" />
                  <div className="h-3 w-1/2 rounded bg-stone-200" />
                  <div className="h-24 w-full rounded bg-gradient-to-r from-stone-200 via-stone-100 to-stone-200 bg-[length:200%_100%] mt-6" style={{ animation: "shimmer 1.4s linear infinite" }} />
                  <div className="h-3 w-3/4 rounded bg-stone-200" />
                  <div className="h-3 w-2/3 rounded bg-stone-200" />
                  <div className="h-48 w-full rounded bg-gradient-to-r from-stone-200 via-stone-100 to-stone-200 bg-[length:200%_100%] mt-6" style={{ animation: "shimmer 1.4s linear infinite" }} />
                </div>
                <div className="absolute bottom-8 left-0 right-0 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
                  <svg className="animate-spin text-amber-500" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Renderizando vista previa…
                </div>
              </div>
            )}
            {!previewLoading && (
              // iframe a ancho fijo de A4 (794px = 210mm @ 96dpi). En
              // desktop el contenedor es más ancho → centrado natural; en
              // móvil el contenedor hace scroll horizontal y el pinch-zoom
              // del parent escala todo. Eso da el comportamiento que el
              // doctor quiere: arranca en page-width, permite hacer zoom.
              <div className="mx-auto" style={{ width: 794 }}>
                <iframe
                  srcDoc={previewHTML}
                  title="Vista previa del protocolo"
                  className="bg-white block"
                  sandbox="allow-same-origin"
                  style={{
                    width: 794,
                    height: "calc(100vh - 60px)",
                    border: 0,
                    animation: "fadeIn 250ms ease-out",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
