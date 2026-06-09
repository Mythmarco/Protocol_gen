"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PROTOCOL_JSON_MARKER, type ProtocoloData } from "@/lib/protocol-types";
import VoiceAgent from "./VoiceAgent";
import AIOrb from "./AIOrb";
import LandingHero from "./chat/LandingHero";
import MobileHistoryScreen from "./chat/MobileHistoryScreen";
import ThinkingIndicator from "./chat/ThinkingIndicator";
import type { HistoryItem } from "./chat/types";
import { injectMobilePreviewCloseButton } from "@/lib/preview-overlay";
import { EMPTY_TEMPLATE, EXAMPLE_TEMPLATES } from "@/lib/quick-templates";

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


export default function ChatPage({ user, history: initialHistory }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  // AbortController del fetch de /api/chat en curso. Cuando el doctor
  // toca historial / "Nueva conversación" / cambia a voice mode mientras
  // hay un stream activo, abortamos el fetch antes de tocar el state
  // de mensajes. Sin esto, el reader.read() seguía corriendo en
  // background y clobbereaba el banner del protocolo cargado con turnos
  // del chat anterior. Bug encontrado por el workflow exhaustivo.
  const streamAbortRef = useRef<AbortController | null>(null);
  const abortChatStream = useCallback(() => {
    if (streamAbortRef.current) {
      try {
        streamAbortRef.current.abort();
      } catch {}
      streamAbortRef.current = null;
    }
    setIsStreaming(false);
  }, []);
  const [pendingProtocol, setPendingProtocol] = useState<ProtocoloData | null>(null);
  // When the protocol on screen matches what's already archived in BD/Drive,
  // we keep a snapshot here so we can render an "Archivado" UI instead of
  // "Guardar PDF". Set when loading from history or right after saving;
  // cleared the moment the doctor edits the draft.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    datos_json: ProtocoloData;
    folio: string;
    driveUrl: string | null;
    // ID del row en Supabase. Cuando el doctor edita un protocolo
    // cargado del historial y vuelve a guardar, mandamos este ID como
    // originId para que /api/pdf haga UPDATE en sitio (mismo folio,
    // mismo row) en vez de INSERT con folio nuevo (= duplicación de
    // historial clínico). null para drafts nuevos que aún no se han
    // guardado.
    originId: string | null;
  } | null>(null);
  const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  // Web Share API con files (level 2) — solo en HTTPS y solo cuando el
  // browser puede compartir blobs PDF. Lo detectamos al montar para que
  // el botón Compartir aparezca o no de manera estable durante la sesión
  // (evita flicker si el doctor recarga). iOS Safari standalone: SÍ.
  // Chrome desktop: NO (al menos hasta el 122). El fallback en desktop
  // es copiar la URL de Drive al portapapeles.
  const canShareFiles =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Mobile-only: which bottom sheet is open
  const [mobileSheet, setMobileSheet] = useState<null | "history" | "account">(null);
  // Mode: text (Claude chat) or voice (OpenAI Realtime)
  const [mode, setMode] = useState<"text" | "voice">("text");
  // IDs de protocolos ya vistos por el usuario. Persistido en localStorage.
  // El badge del nav móvil cuenta cuántos protocolos hay en `history` cuyo
  // id NO está aquí — i.e., creados pero no vistos todavía.
  // Lazy initializer: corre UNA VEZ en el primer render (no en cada uno).
  // Antes lo hacíamos en un useEffect — eso disparaba un re-render extra y
  // generaba el warning react-hooks/set-state-in-effect. Hacerlo aquí es
  // SSR-safe porque chequeamos typeof window.
  const [seenIds, setSeenIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = window.localStorage.getItem("p4a:seenProtocolIds");
      if (stored) return new Set(JSON.parse(stored) as string[]);
      // Primera vez en este dispositivo: baseline = todo el history actual.
      const baseline = new Set(initialHistory.map((i) => i.id));
      try {
        window.localStorage.setItem(
          "p4a:seenProtocolIds",
          JSON.stringify([...baseline])
        );
      } catch {}
      return baseline;
    } catch (err) {
      console.warn("[history] seenIds init failed:", err);
      return new Set();
    }
  });
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
  // Bump-key para VoiceAgent — al cambiar, React desmonta y remonta el
  // componente, lo que dispara su cleanup (cierra WebRTC + apaga mic).
  // Usado al cargar un protocolo del historial para que NO se quede una
  // sesión de voz vieja activa mientras el doctor revisa el cargado.
  const [voiceSessionKey, setVoiceSessionKey] = useState(0);
  // Diálogo de confirmación para "vas a perder la conversación actual".
  // Se muestra cuando el doctor toca un item del historial mientras tiene
  // una conversación viva (voice o text). null = cerrado; HistoryItem =
  // pending de cargar si confirma.
  const [pendingHistoryLoad, setPendingHistoryLoad] = useState<HistoryItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHTML, setPreviewHTML] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  // Toast — soporta tres estados:
  //   "ok"      → verde, "Protocolo guardado · folio · Abrir en Drive"
  //   "warning" → ámbar, el PDF se renderizó pero NO se archivó en BD/Drive
  //   "error"   → rojo, el render mismo falló (reemplaza al alert viejo)
  // Auto-dismiss después de unos segundos.
  const [toast, setToast] = useState<{
    status: "ok" | "warning" | "error";
    folio: string;
    driveUrl: string;
    message?: string;
    visible: boolean;
  } | null>(null);

  // Helper para mostrar el toast con auto-dismiss. Centraliza los timeouts.
  const showToast = useCallback(
    (
      status: "ok" | "warning" | "error",
      payload: { folio?: string; driveUrl?: string; message?: string }
    ) => {
      const dwell = status === "ok" ? 6000 : 9000; // errores dejan más tiempo
      setToast({
        status,
        folio: payload.folio ?? "",
        driveUrl: payload.driveUrl ?? "",
        message: payload.message,
        visible: true,
      });
      window.setTimeout(
        () => setToast((t) => (t ? { ...t, visible: false } : null)),
        dwell
      );
      window.setTimeout(() => setToast(null), dwell + 400);
    },
    []
  );
  // Voice
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recError, setRecError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll-to-bottom estrategia:
  //   - cuando aparece un mensaje NUEVO (cambio en messages.length) → smooth
  //     scroll para que el usuario sienta el movimiento.
  //   - mientras el último mensaje crece carácter-a-carácter (streaming) →
  //     auto-scroll throttled cada 120ms con behavior:"auto" (instantáneo).
  //     "smooth" en cada token reinicia la animación y causa jank brutal en
  //     iOS (visible como vibración del scroll).
  const lastMessagesLenRef = useRef(0);
  const lastScrollTsRef = useRef(0);
  useEffect(() => {
    const isNewMessage = messages.length !== lastMessagesLenRef.current;
    lastMessagesLenRef.current = messages.length;
    if (isNewMessage) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      lastScrollTsRef.current = Date.now();
      return;
    }
    // Streaming growth: throttle a 120ms y scroll instantáneo.
    const now = Date.now();
    if (now - lastScrollTsRef.current >= 120) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
      lastScrollTsRef.current = now;
    }
  }, [messages]);

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

  // Helper para marcar TODO el history actual como visto. Se llama desde
  // los event handlers (tap en "Historial", post-save, etc.) — NO desde
  // useEffect porque eso dispara cascading renders.
  const markAllHistorySeen = useCallback(() => {
    markSeen(history.map((it) => it.id));
  }, [history, markSeen]);

  // Detección barata de "esto es un móvil" — usamos viewport width porque
  // iOS Safari miente con userAgent y `matchMedia('(pointer:coarse)')` no
  // es 100% confiable en simuladores. 768px coincide con el breakpoint
  // md: de Tailwind y es donde aparece el bottom-nav.
  const isMobileViewport = () =>
    typeof window !== "undefined" && window.innerWidth < 768;

  // Declarado ANTES de handleSend porque handleSend lo llama. JS hoisting no
  // aplica a useCallback (vs function declaration), así que el orden léxico
  // importa — el lint react-hooks/set-state-in-effect lo rechazaba antes.
  // Preview tiene DOS modos:
  //   - "auto"    → invocado SIN user-gesture (al terminar el handoff, etc.)
  //                 Usa el modal in-app. window.open desde un async post-tool
  //                 lo bloquea iOS Safari como popup, así que NUNCA intentamos.
  //   - "gesture" → invocado desde un tap directo del doctor (botón Vista
  //                 previa). En móvil abrimos new tab para pinch-zoom nativo;
  //                 en desktop usamos el modal igual.
  const openPreview = useCallback(
    async (
      protocol: ProtocoloData,
      source: "auto" | "gesture" = "gesture"
    ) => {
      const wantsNewTab = source === "gesture" && isMobileViewport();

      if (wantsNewTab) {
        // Tab nueva SOLO dentro del gesture handler (tap). Si llegamos aquí
        // desde un async post-tool, fallaría — por eso obligamos a que el
        // caller marque "gesture" explícitamente.
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
            // Navegamos al Blob URL en lugar de document.write — iOS Safari
            // no re-procesa el meta viewport cuando el documento se reescribe
            // en vivo, y el doctor reportaba que la primera vez se veía mal
            // alineada y había que cerrar/abrir. Con Blob URL es un load
            // completo del documento → viewport fit-to-width desde el primer
            // paint.
            const htmlWithClose = injectMobilePreviewCloseButton(html);
            const blob = new Blob([htmlWithClose], {
              type: "text/html;charset=utf-8",
            });
            const blobUrl = URL.createObjectURL(blob);
            tab.location.replace(blobUrl);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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

      // Modal in-app (desktop siempre, móvil sólo en auto-open post-handoff).
      // El modal tiene botón "Cerrar" claro arriba y opción de "Abrir en
      // pestaña" para que el doctor pueda activar pinch-zoom si quiere.
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
        setPreviewHTML(
          "<p style='padding:2rem;font-family:sans-serif'>No se pudo cargar la vista previa.</p>"
        );
      } finally {
        setPreviewLoading(false);
      }
    },
    []
  );

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

    // Crea un AbortController nuevo para este stream. Si el doctor
    // navega lejos antes de que termine, abortChatStream lo dispara y
    // todos los setMessages dentro del while loop se vuelven no-op por
    // el guard signal.aborted abajo.
    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
    const signal = ctrl.signal;

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
        signal,
      });

      if (!res.ok) throw new Error("Error en la solicitud");

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        // Si abortChatStream se llamó, salimos sin mutar más estado —
        // el state del chat le pertenece a otra vista ya.
        if (signal.aborted) return;
        fullText += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: fullText };
          return updated;
        });
      }

      if (signal.aborted) return;
      const protocol = extractProtocolJSON(fullText);
      if (protocol) {
        setPendingProtocol(protocol);
        // "auto" — post-stream, sin user gesture. En móvil debe ser modal.
        openPreview(protocol, "auto");
      }
    } catch (err) {
      // AbortError es nuestro — no es un error real, no mostramos toast.
      if ((err as Error)?.name === "AbortError" || signal.aborted) return;
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
      if (streamAbortRef.current === ctrl) streamAbortRef.current = null;
      setIsStreaming(false);
    }
  }, [input, isStreaming, messages, pendingProtocol, openPreview]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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

      // originId: si el doctor cargó un protocolo del historial Y NO lo
      // editó tanto que invalidó el snapshot, mandamos el id original
      // para que el server haga UPDATE en sitio en vez de INSERT con
      // folio nuevo. Sin esto el historial se duplicaba en cada save.
      const originId = savedSnapshot?.originId ?? null;
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolData: pendingProtocol,
          conversacion,
          conversacion_modo,
          ...(originId ? { originId } : {}),
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

      // Headers que el server expone con CORS:
      //   X-Folio        → folio asignado
      //   X-Drive-Url    → URL en Drive (vacío si no se subió)
      //   X-Save-Status  → "ok" | "failed"  (NEW)
      //   X-Save-Error   → detalle si failed (NEW)
      const folio = res.headers.get("X-Folio") || "";
      const driveUrl = res.headers.get("X-Drive-Url") || "";
      const saveStatus = res.headers.get("X-Save-Status") || "ok";
      const saveError = res.headers.get("X-Save-Error") || "";

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

      if (saveStatus === "ok") {
        showToast("ok", { folio, driveUrl });
        // El protocolo SÍ se archivó → flip a estado "archivado".
        // El originId que pasamos arriba (savedSnapshot?.originId) ahora
        // queda como el row de este protocolo — la próxima edición hará
        // UPDATE en el mismo lugar. Si era un draft NUEVO sin originId,
        // /api/history/[id] nos lo proveerá al re-cargar.
        setSavedSnapshot({
          datos_json: pendingProtocol,
          folio,
          driveUrl: driveUrl || null,
          originId: originId,
        });
      } else {
        // El PDF se generó pero algo del archivado falló (Drive o Supabase).
        // El doctor ya tiene el PDF descargado, pero NO marcamos como archivado.
        showToast("warning", {
          folio,
          message: saveError || "El protocolo no se guardó en Drive/BD.",
        });
      }

      // Close the preview modal — user saw it before saving, no need to keep it
      setPreviewOpen(false);

      // Refresh history sidebar (solo si se guardó OK; si falló no hay row nuevo)
      if (saveStatus === "ok") {
        const histRes = await fetch("/api/history");
        if (histRes.ok) {
          const { items } = (await histRes.json()) as { items: HistoryItem[] };
          setHistory(items);
          // El doctor ACABA de crear este protocolo — obviamente ya lo
          // conoce. Lo marcamos visto inmediatamente para no inflar el
          // badge con su propio trabajo.
          markSeen(items.map((it) => it.id));
        }
      }
    } catch (err) {
      console.error(err);
      showToast("error", {
        message:
          err instanceof Error
            ? err.message
            : "Error desconocido al guardar el PDF.",
      });
    } finally {
      setIsGeneratingPDF(false);
    }
  };

  // Re-download a protocol that is already archived. Calls /api/pdf with
  // mode="download" so it just renders + returns — no new folio, no Drive
  // upload, no duplicate row in Supabase.
  // Card que sirve para "como parte del último output del agente":
  //   - inline bajo el último mensaje en text mode (chat thread)
  //   - al final del transcript en voice mode (via prop bottomActionCard)
  // Estado dual:
  //   - Si el protocolo en pantalla === savedSnapshot.datos_json → archivado
  //     (botones: Vista previa, Descargar, Abrir en Drive)
  //   - Si es draft nuevo (no archivado) → Vista previa + Guardar PDF
  const renderProtocolActionCard = (protocol: ProtocoloData) => {
    const isArchived =
      savedSnapshot != null && savedSnapshot.datos_json === protocol;
    // 4 botones unificados — el orden es el mismo en draft y archivado
    // para que el doctor encuentre cada acción siempre en el mismo lugar.
    // Si no está archivado, "Guardar" sube a Drive + BD; si ya está, ese
    // botón se reemplaza por un badge "Archivado" + el link a Drive.
    return (
      <div className="mt-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          {isArchived ? (
            <span
              className="flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-semibold"
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
            <span className="text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full font-semibold">
              ✓ Protocolo generado
            </span>
          )}
          {isArchived && savedSnapshot?.driveUrl && (
            <a
              href={savedSnapshot.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-stone-500 hover:text-amber-600 underline underline-offset-2"
            >
              Abrir en Drive
            </a>
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => openPreview(protocol)}
            className="flex items-center justify-center gap-1.5 text-xs border border-stone-300 hover:border-amber-400 bg-white text-stone-700 hover:text-amber-700 rounded-lg px-2 py-1.5 font-semibold transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            Vista previa
          </button>

          <button
            onClick={() => handleDownloadOnly(protocol)}
            disabled={isDownloading}
            className="flex items-center justify-center gap-1.5 text-xs border border-stone-300 hover:border-amber-400 bg-white text-stone-700 hover:text-amber-700 disabled:opacity-60 rounded-lg px-2 py-1.5 font-semibold transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            {isDownloading ? "Descargando…" : "Descargar"}
          </button>

          {isArchived ? (
            <button
              disabled
              className="flex items-center justify-center gap-1.5 text-xs border border-stone-200 bg-stone-50 text-stone-400 rounded-lg px-2 py-1.5 font-semibold cursor-not-allowed"
              title="Ya está guardado en Drive"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Guardado
            </button>
          ) : (
            <button
              onClick={handleDownloadPDF}
              disabled={isGeneratingPDF}
              className="flex items-center justify-center gap-1.5 text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-white rounded-lg px-2 py-1.5 font-semibold transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
              </svg>
              {isGeneratingPDF ? "Guardando…" : "Guardar"}
            </button>
          )}

          <button
            onClick={() => handleShare(protocol)}
            disabled={isSharing}
            className="flex items-center justify-center gap-1.5 text-xs border border-stone-300 hover:border-amber-400 bg-white text-stone-700 hover:text-amber-700 disabled:opacity-60 rounded-lg px-2 py-1.5 font-semibold transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            {isSharing
              ? "Compartiendo…"
              : canShareFiles
              ? "Compartir"
              : "Copiar link"}
          </button>
        </div>
      </div>
    );
  };

  // Render PDF SIN archivar — no folio nuevo, no Drive upload, no row
  // en Supabase. Lo usan los botones "Descargar" y "Compartir" para
  // obtener el blob del PDF sin afectar el estado de "archivado".
  // El folio que regresa el server es el guardado en datos_json (o
  // vacío si nunca se guardó).
  const fetchPdfBlob = async (protocol: ProtocoloData): Promise<{ blob: Blob; folio: string }> => {
    const res = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolData: protocol, mode: "download" }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `PDF API ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
      );
    }
    const folio =
      res.headers.get("X-Folio") ||
      protocol.cotizacion?.folio ||
      "";
    const blob = await res.blob();
    return { blob, folio };
  };

  const handleDownloadOnly = async (protocol: ProtocoloData) => {
    setIsDownloading(true);
    try {
      const { blob, folio } = await fetchPdfBlob(protocol);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const nombreSlug = protocol.paciente.nombre
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      a.href = url;
      a.download = `${folio || nombreSlug}-${protocol.metadata.fecha}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast("error", {
        message:
          err instanceof Error ? err.message : "No se pudo descargar el PDF.",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleShare = async (protocol: ProtocoloData) => {
    setIsSharing(true);
    try {
      const { blob, folio } = await fetchPdfBlob(protocol);
      const nombreSlug = protocol.paciente.nombre
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      const fileName = `${folio || nombreSlug}-${protocol.metadata.fecha}.pdf`;
      const file = new File([blob], fileName, { type: "application/pdf" });
      const shareData = {
        files: [file],
        title: `Protocolo de ${protocol.paciente.nombre}`,
        text: `Protocolo Peptides4ALL — ${protocol.paciente.nombre}`,
      };

      if (
        typeof navigator !== "undefined" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare(shareData) &&
        typeof navigator.share === "function"
      ) {
        await navigator.share(shareData);
      } else {
        // Fallback desktop / browsers sin Web Share API Level 2: si el
        // protocolo está archivado, copiamos la URL de Drive. Si no,
        // simplemente disparamos descarga local.
        const driveUrl =
          savedSnapshot?.datos_json === protocol ? savedSnapshot.driveUrl : null;
        if (driveUrl) {
          await navigator.clipboard.writeText(driveUrl);
          showToast("ok", {
            message: "Link de Drive copiado al portapapeles.",
          });
        } else {
          // Sin fallback razonable → descarga local.
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(url);
          showToast("warning", {
            message: "Compartir directo no disponible — PDF descargado.",
          });
        }
      }
    } catch (err) {
      // AbortError = el usuario canceló el share sheet, no es error real.
      if (err instanceof Error && err.name === "AbortError") return;
      console.error(err);
      showToast("error", {
        message:
          err instanceof Error ? err.message : "No se pudo compartir el PDF.",
      });
    } finally {
      setIsSharing(false);
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
    // "Nuevo" = arrancar de cero. Volvemos a la landing hero para que el
    // doctor reelija modo (texto/voz). Antes solo vaciábamos mensajes y
    // dejaba al usuario en un empty state mudo — parecía que no había
    // pasado nada al tocar el botón en PWA. Con la cross-fade se ve
    // claramente el reset.
    // ANTES del cross-fade abortamos cualquier stream de chat en curso
    // — si no, el setMessages del reader.read() seguía corriendo y
    // metía un bubble en la pantalla limpia de la landing.
    abortChatStream();
    runViewTransition(() => {
      setMessages([]);
      setPendingProtocol(null);
      setSavedSnapshot(null);
      setInput("");
      setVoiceTranscript([]);
      setVoiceSeed(undefined);
      setLandingShown(true);
      setMobileSheet(null);
    });
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

  // Hay una conversación viva si el doctor tiene mensajes en modo texto
  // o turnos en modo voz. Si NO la hay, podemos cargar el historial sin
  // pedir confirmación (es el caso común: vienes del landing y picas un
  // protocolo de la lista — no perdés nada).
  const hasActiveConversation =
    !landingShown && (messages.length > 0 || voiceTranscript.length > 0);

  // Punto de entrada desde el UI (clic en historial). Si hay conversación
  // viva muestra el modal de confirmación; si no, carga directo.
  const requestLoadHistory = (item: HistoryItem) => {
    if (hasActiveConversation) {
      // Cerramos el sheet de historial primero para que el modal se vea
      // limpio sobre la conversación, no apilado sobre la lista.
      setMobileSheet(null);
      setPendingHistoryLoad(item);
      return;
    }
    handleLoadHistory(item);
  };

  const handleLoadHistory = async (item: HistoryItem) => {
    // Aborta cualquier stream de /api/chat en curso. Sin esto el reader
    // seguía empujando setMessages al fondo y clobbereaba el banner del
    // protocolo recién cargado con turnos del chat anterior. Bug
    // encontrado por el workflow exhaustivo.
    abortChatStream();
    // Si veníamos de una conversación activa, bumpeamos voiceSessionKey
    // ANTES del cross-fade para que VoiceAgent se desmonte y cierre su
    // WebRTC + libere el mic. Sin esto la sesión seguía corriendo encima
    // del transcript cargado y el agente respondía al doctor cuando
    // hablaba aunque visualmente ya estaba en otro protocolo.
    if (hasActiveConversation) {
      setVoiceSessionKey((k) => k + 1);
    }
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
      // Marca datos_json como cargado del historial — el endpoint /api/chat
      // lee este flag y le dice al modelo: 'NO reuses precios, re-valida con
      // get_product_price'. Workflow encontró que sin esto los protocolos
      // viejos se re-cotizaban con precios stale (paciente pagaba mal).
      if (datos_json && typeof datos_json === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (datos_json as any)._meta = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...((datos_json as any)._meta ?? {}),
          loaded_from_history: true,
          origin_id: item.id,
        };
      }
      setPendingProtocol(datos_json);
      setSavedSnapshot({
        datos_json,
        folio: folio || datos_json.cotizacion?.folio || "",
        driveUrl: drive_url ?? null,
        originId: item.id, // → /api/pdf hará UPDATE en sitio al guardar
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

  // h-[100dvh] = "dynamic viewport height" — en iOS Safari ajusta su
  // altura cuando la URL bar se muestra/oculta. h-screen (100vh) usa
  // SIEMPRE el max viewport y dejaba contenido tapado por la URL bar en
  // sesiones largas. dvh es la solución estándar 2026 para PWAs.
  return (
    <div className="flex h-[100dvh] bg-stone-50 font-sans overflow-hidden">
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
                  onClick={() => requestLoadHistory(item)}
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
        <header
          className="flex items-center gap-3 px-4 py-3 bg-white border-b border-stone-200"
          style={{
            // PWA standalone en iOS necesita reservar espacio bajo el notch.
            // Sin esto el logo queda parcialmente tapado por el status bar.
            paddingTop: "max(0.75rem, env(safe-area-inset-top))",
          }}
        >
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


        {/* View swap wrapper — landing, voice y text mode comparten esta
             caja para poder cross-fade entre ellos sin reflow brusco. */}
        <div
          className="relative flex flex-col flex-1 min-h-0"
          style={{
            opacity: viewTransition ? 0 : 1,
            transition: "opacity 200ms ease-out",
            // Reserva espacio para el bottom nav fijo en móvil. Sin esto el
            // último mensaje / composer queda tapado por el nav.
            paddingBottom:
              typeof window !== "undefined" && window.innerWidth < 768
                ? "calc(64px + env(safe-area-inset-bottom))"
                : 0,
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
              // key={voiceSessionKey}: al cargar protocolo del historial
              // bumpeamos esta key para que VoiceAgent se desmonte (cierra
              // WebRTC + mic) y remonte limpio con el seed nuevo. Sin esto
              // la sesión activa seguía corriendo encima del transcript
              // cargado, mezclando turnos viejos con turnos del histórico.
              key={voiceSessionKey}
              // First name only — full name sounds awkward in voice ("Hola Marco Saenz Lopez...")
              doctorName={(user.name || user.email.split("@")[0]).split(/\s+/)[0]}
              onProtocolGenerated={(data) => {
                setPendingProtocol(data);
                // El VoiceAgent YA pre-abrió la pestaña con el PDF en
                // móvil (intento sincrónico desde el tool execute). En
                // desktop, abrimos el modal in-app como fallback.
                // Importante: NO llamamos openPreview en móvil aquí — si
                // el window.open del VoiceAgent fue bloqueado, igual
                // tenemos el bottomActionCard con el botón "Vista previa"
                // que el doctor puede tocar (gesture → tab nueva, función
                // probada).
                if (!isMobileViewport()) {
                  openPreview(data, "auto");
                }
              }}
              onTranscriptChange={setVoiceTranscript}
              initialTranscript={voiceSeed}
              onNewConversation={() => {
                // VoiceAgent ya limpia su transcript; aquí limpiamos los
                // estados de ChatPage que controlan el toolbar superior
                // (Archivado / Vista previa / Descargar). Sin esto el
                // toolbar se quedaba colgado tras salir de un protocolo
                // cargado de historial.
                setPendingProtocol(null);
                setSavedSnapshot(null);
                setMessages([]);
                setVoiceSeed(undefined);
                setVoiceTranscript([]);
                setInput("");
              }}
              // Pasa el action card al final del transcript de voz para que
              // los botones Vista previa / Descargar / Drive aparezcan
              // "como parte del último output del agente", no como un
              // toolbar separado arriba.
              bottomActionCard={
                pendingProtocol
                  ? renderProtocolActionCard(pendingProtocol)
                  : null
              }
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
                {EXAMPLE_TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    onClick={() => {
                      setInput(t.fullText);
                      requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (el) {
                          el.style.height = "auto";
                          el.style.height = Math.min(el.scrollHeight, 320) + "px";
                          el.focus();
                        }
                      });
                    }}
                    className="text-left text-sm bg-white border border-stone-200 hover:border-amber-400 rounded-xl px-4 py-2.5 transition-colors"
                  >
                    <span className="font-medium text-stone-700">{t.label}</span>
                    <span className="block text-xs text-stone-400 mt-0.5">
                      Plantilla completa lista para enviar
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => {
                    setInput(EMPTY_TEMPLATE);
                    requestAnimationFrame(() => {
                      const el = textareaRef.current;
                      if (el) {
                        el.style.height = "auto";
                        el.style.height = Math.min(el.scrollHeight, 320) + "px";
                        el.focus();
                      }
                    });
                  }}
                  className="self-center mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 rounded-full px-3.5 py-1.5 transition-all"
                  title="Inserta una plantilla vacía con todos los campos para que la llenes"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="9" y1="13" x2="15" y2="13"/>
                    <line x1="9" y1="17" x2="15" y2="17"/>
                  </svg>
                  Plantilla rápida (en blanco)
                </button>
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

                  {isAssistant && protocol && renderProtocolActionCard(protocol)}
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

        {/* Bottom nav (mobile only). FIXED al fondo del viewport para que
             siempre sirva como barra de navegación independiente del
             contenido (el doctor lo pidió). El contenido por encima reserva
             espacio con padding-bottom (ver view-swap wrapper). z-30 para
             tapar contenido normal pero quedar DEBAJO del modal de historial
             (z-60) cuando se abra. Y se oculta defensivamente con `hidden`
             cuando hay un sheet abierto para que no compita visualmente. */}
        <nav
          className={`md:hidden ${mobileSheet ? "hidden" : "flex"} fixed bottom-0 left-0 right-0 z-30 items-center justify-around bg-white border-t border-stone-200 px-2 py-2 safe-area-inset-bottom`}
        >
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
            onClick={() => {
              setMobileSheet("history");
              markAllHistorySeen();
            }}
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
            // requestLoadHistory cierra el sheet móvil internamente cuando
            // pide confirmación; en el flujo directo lo cierra el cross-
            // fade del handleLoadHistory. Aquí no lo cerramos doble.
            requestLoadHistory(item);
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

      {/* Toast (top-center, auto-dismisses). Variantes: ok / warning / error.
           Reemplaza al alert() viejo que en iOS PWA se veía fatal y bloqueaba. */}
      {toast && (() => {
        const variant =
          toast.status === "ok"
            ? {
                iconBg: "bg-green-500",
                title: `Protocolo guardado · ${toast.folio || "—"}`,
                body: "Registrado en la base y descargado.",
                icon: (
                  <polyline points="20 6 9 17 4 12" />
                ),
              }
            : toast.status === "warning"
            ? {
                iconBg: "bg-amber-500",
                title: `PDF generado · ${toast.folio || "—"}`,
                body:
                  toast.message ||
                  "El PDF se descargó pero NO se archivó en la base.",
                icon: (
                  <>
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  </>
                ),
              }
            : {
                iconBg: "bg-red-500",
                title: "No se pudo guardar el PDF",
                body: toast.message || "Error desconocido.",
                icon: (
                  <>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </>
                ),
              };

        return (
          <div
            className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none px-4"
            style={{
              opacity: toast.visible ? 1 : 0,
              transform: `translateX(-50%) translateY(${toast.visible ? 0 : -8}px)`,
              transition: "opacity 350ms ease-out, transform 350ms ease-out",
            }}
          >
            <div className="bg-stone-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 max-w-md pointer-events-auto">
              <div className={`w-8 h-8 rounded-full ${variant.iconBg} flex items-center justify-center flex-shrink-0`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  {variant.icon}
                </svg>
              </div>
              <div className="flex-1 text-sm min-w-0">
                <div className="font-semibold truncate">{variant.title}</div>
                <div className="text-xs text-stone-300 break-words">
                  {variant.body}
                  {toast.status === "ok" && toast.driveUrl && (
                    <>
                      {" "}
                      <a
                        href={toast.driveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-amber-300"
                      >
                        Abrir en Drive
                      </a>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={() => setToast(null)}
                className="text-stone-400 hover:text-white transition-colors flex-shrink-0 p-1 -mr-1"
                aria-label="Cerrar notificación"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        );
      })()}

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
              // iframe a ancho fijo de A4 (794px = 210mm @ 96dpi).
              // En desktop NO escalamos — el contenedor ya es más ancho.
              // En móvil aplicamos transform: scale(viewport/794) con
              // transformOrigin "top left" para que el visual escalado
              // ARRANQUE en el borde izquierdo del modal y no se salga.
              // Antes usábamos "top center" + mx-auto, lo que dejaba el
              // visual centrado en x=397 del box no-escalado de 794 —
              // dentro de un viewport de 390 el visible era la mitad
              // DERECHA del protocolo (Patient Data corrido, header
              // cortado). Era el bug "se ve mal alineada y tengo que
              // cerrar y abrir".
              (() => {
                const vw =
                  typeof window !== "undefined" ? window.innerWidth : 0;
                const isMobile = vw > 0 && vw < 768;
                const scale = isMobile
                  ? Math.min(1, (vw - 16) / 794)
                  : 1;
                return (
                  <div
                    style={{
                      width: isMobile ? vw - 16 : 794,
                      marginLeft: "auto",
                      marginRight: "auto",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: 794,
                        transformOrigin: "top left",
                        transform: `scale(${scale})`,
                      }}
                    >
                      <iframe
                        srcDoc={previewHTML}
                        title="Vista previa del protocolo"
                        className="bg-white block"
                        sandbox="allow-same-origin"
                        style={{
                          width: 794,
                          height: `calc((100dvh - 60px) / ${scale})`,
                          border: 0,
                          animation: "fadeIn 250ms ease-out",
                        }}
                      />
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>
      )}

      {/* Confirmación: "vas a perder la conversación actual al cargar
          este protocolo". Se muestra cuando el doctor toca un item del
          historial mientras tiene una conversación viva (mensajes en
          modo texto o turnos en modo voz). Es un modal in-app — el
          confirm() nativo del browser se ve roto en PWA standalone. */}
      {pendingHistoryLoad && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 p-4"
          style={{ animation: "fadeIn 180ms ease-out" }}
          onClick={() => setPendingHistoryLoad(null)}
        >
          <div
            className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-stone-200 p-5"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "fadeIn 220ms ease-out" }}
          >
            <h3 className="text-base font-semibold text-stone-900 mb-1">
              ¿Cerrar la conversación actual?
            </h3>
            <p className="text-sm text-stone-600 mb-4 leading-relaxed">
              {mode === "voice"
                ? "La sesión de voz se va a cerrar y voy a cargar el protocolo de "
                : "La conversación actual se va a cerrar y voy a cargar el protocolo de "}
              <span className="font-semibold text-stone-800">
                {pendingHistoryLoad.paciente_nombre}
              </span>
              . Podrás seguir editándolo por texto o por voz.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingHistoryLoad(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-stone-200 text-stone-700 font-medium text-sm hover:bg-stone-50 active:bg-stone-100 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const item = pendingHistoryLoad;
                  setPendingHistoryLoad(null);
                  handleLoadHistory(item);
                }}
                className="flex-1 px-4 py-2.5 rounded-xl bg-stone-900 text-white font-medium text-sm hover:bg-stone-800 active:bg-stone-700 transition-colors"
              >
                Cargar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
