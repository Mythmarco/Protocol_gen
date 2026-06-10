"use client";

import { useEffect, useState } from "react";

// Editor del tipo de cambio MXN/USD. Aparece en el sheet de Cuenta
// (móvil + desktop). Valor persistido en protocol_gen_settings vía
// /api/fx. Cascada: BD del doctor → env PEPTIDES_MXN_PER_USD → 18.5.

type FxResponse = { rate: number; source: "user" | "env" | "default" };

interface Props {
  /** Si true, el card arranca colapsado (solo header con valor) y se
   *  expande al toque. Útil en el sidebar desktop donde el espacio es
   *  premium. En móvil (sheet de Cuenta) lo dejamos siempre expandido
   *  porque el sheet ya es modal y tiene espacio. */
  collapsible?: boolean;
}

const COLLAPSED_KEY = "p4a:fx-setting:collapsed";

export default function FxRateSetting({ collapsible = false }: Props) {
  const [data, setData] = useState<FxResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Estado colapsado SOLO cuando collapsible=true. Persiste en
  // localStorage para que la preferencia del doctor se mantenga entre
  // sesiones. Default: colapsado (Marco reportó que tapaba).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!collapsible || typeof window === "undefined") return false;
    try {
      const stored = window.localStorage.getItem(COLLAPSED_KEY);
      return stored === null ? true : stored === "1";
    } catch {
      return true;
    }
  });
  const setCollapsedPersist = (next: boolean) => {
    setCollapsed(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/fx")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FxResponse | null) => {
        if (!cancelled && d) {
          setData(d);
          setDraft(d.rate.toFixed(2));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ rate: 18.5, source: "default" });
          setDraft("18.50");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setError(null);
    const rate = Number(draft.replace(",", "."));
    if (!Number.isFinite(rate) || rate < 10 || rate > 40) {
      setError("El valor debe estar entre 10 y 40 pesos por dólar");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/fx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Error al guardar (${res.status})`);
        return;
      }
      setData({ rate: body.rate, source: "user" });
      setDraft(Number(body.rate).toFixed(2));
      setEditing(false);
      setJustSaved(true);
      // Quita el "✓ Guardado" badge a los 3s.
      setTimeout(() => setJustSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
      setSaving(false);
    }
  };

  // Texto humano para cada fuente — antes era "Default Vercel" / "Fallback"
  // que no le decía nada a un doctor. Ahora explica QUÉ es y QUÉ significa
  // para él.
  const sourceMeta = (s: FxResponse["source"]) => {
    if (s === "user") {
      return {
        label: "Tu valor personalizado",
        explanation:
          "Configurado por ti — se aplica a todas tus cotizaciones en USD.",
        iconColor: "text-emerald-600",
        iconBg: "bg-emerald-100",
        icon: <polyline points="20 6 9 17 4 12" />,
      };
    }
    if (s === "env") {
      return {
        label: "Valor del sistema",
        explanation:
          "Configurado en Vercel (predeterminado). Puedes personalizarlo aquí abajo.",
        iconColor: "text-amber-700",
        iconBg: "bg-amber-100",
        icon: (
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </>
        ),
      };
    }
    return {
      label: "Valor base de respaldo",
      explanation:
        "No hay valor configurado. Estamos usando 18.50 como respaldo. Personaliza para tu negocio.",
      iconColor: "text-stone-600",
      iconBg: "bg-stone-100",
      icon: (
        <>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </>
      ),
    };
  };

  if (!data) {
    return (
      <div className="text-xs text-stone-400 py-2">
        Cargando tipo de cambio…
      </div>
    );
  }

  const meta = sourceMeta(data.source);

  // Header con título e icono. Si collapsible=true, el header se
  // vuelve botón clickeable que toggle el body + muestra inline el
  // valor actual (para que el doctor lo vea sin expandir).
  const headerContent = (
    <>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        className="text-amber-600 flex-shrink-0"
        aria-hidden="true"
      >
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
      <h4 className="text-xs font-bold tracking-wider text-stone-700 uppercase">
        Tipo de cambio USD
      </h4>
      {/* Si está colapsado, mostramos el valor inline en el header como
          chip ámbar — el doctor ve el FX sin necesidad de expandir. */}
      {collapsible && collapsed && !editing && (
        <span className="text-xs font-bold text-stone-800 tabular-nums bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 flex-shrink-0">
          ${data.rate.toFixed(2)}
        </span>
      )}
      {justSaved && (
        <span
          className="ml-auto text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
          role="status"
          aria-live="polite"
        >
          ✓ Guardado
        </span>
      )}
      {collapsible && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-stone-500 flex-shrink-0 transition-transform ml-auto ${
            collapsed ? "" : "rotate-180"
          }`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      )}
    </>
  );

  return (
    <div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setCollapsedPersist(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls="fx-setting-body"
          className="w-full flex items-center gap-2 mb-3 rounded-lg hover:bg-stone-50 active:bg-stone-100 -mx-1 px-1 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-center gap-2 mb-3">{headerContent}</div>
      )}

      {/* Body — visible siempre que NO esté colapsado. id para aria-controls. */}
      <div
        id="fx-setting-body"
        hidden={collapsible && collapsed}
        style={{ display: collapsible && collapsed ? "none" : undefined }}
      >

      {!editing ? (
        <>
          {/* Valor grande y unidad — lo primero que el doctor ve. */}
          <div className="flex items-baseline gap-1.5 mb-2.5">
            <span className="text-3xl font-bold text-stone-900 tracking-tight tabular-nums">
              ${data.rate.toFixed(2)}
            </span>
            <span className="text-sm text-stone-500 font-medium">
              MXN por USD
            </span>
          </div>

          {/* Card explicando de DÓNDE viene el valor — friendly, no
              dev-speak. Color ajustado al estado (verde = personalizado,
              ámbar = sistema, gris = fallback). */}
          <div
            className={`flex items-start gap-2.5 rounded-xl border p-2.5 mb-3 ${
              data.source === "user"
                ? "bg-emerald-50/60 border-emerald-200"
                : data.source === "env"
                ? "bg-amber-50/60 border-amber-200"
                : "bg-stone-50 border-stone-200"
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full ${meta.iconBg} flex items-center justify-center flex-shrink-0`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={meta.iconColor}
                aria-hidden="true"
              >
                {meta.icon}
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-semibold ${meta.iconColor}`}>
                {meta.label}
              </div>
              <div className="text-[11px] text-stone-600 mt-0.5 leading-snug">
                {meta.explanation}
              </div>
            </div>
          </div>

          {/* Botón primario — varía el texto según si es la primera vez
              o ya está personalizado. */}
          <button
            onClick={() => {
              setEditing(true);
              setError(null);
            }}
            className="w-full min-h-[44px] flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-800 active:bg-stone-700 text-white rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            {data.source === "user"
              ? "Cambiar tipo de cambio"
              : "Personalizar tipo de cambio"}
          </button>

          {/* Helper bottom — cuando aplica este valor. */}
          <p className="text-[11px] text-stone-500 mt-2 leading-snug">
            Se aplica automáticamente cuando el protocolo se cotiza en USD.
            El PDF muestra el valor usado en la nota de la cotización.
          </p>
        </>
      ) : (
        <>
          {/* Modo edición — input grande, label arriba, hint debajo. */}
          <label
            htmlFor="fx-input"
            className="block text-xs font-semibold text-stone-700 mb-1.5"
          >
            Cuántos pesos vale 1 dólar
          </label>
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-lg text-stone-500 font-bold pointer-events-none">
                $
              </span>
              <input
                id="fx-input"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="10"
                max="40"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                  if (e.key === "Escape") {
                    setEditing(false);
                    setDraft(data.rate.toFixed(2));
                    setError(null);
                  }
                }}
                autoFocus
                className="w-full rounded-xl border-2 border-stone-300 pl-8 pr-3 py-3 text-2xl font-bold text-stone-900 tabular-nums focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
                placeholder="18.50"
                aria-label="Tipo de cambio: pesos mexicanos por dólar"
              />
            </div>
            <span className="text-sm text-stone-500 font-medium whitespace-nowrap">
              MXN/USD
            </span>
          </div>

          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            Valor permitido: entre 10 y 40 pesos por dólar.
          </p>

          {error && (
            <div
              className="mb-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-2.5"
              role="alert"
              aria-live="assertive"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#dc2626"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="text-xs text-red-700 font-medium">{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setDraft(data.rate.toFixed(2));
                setError(null);
              }}
              disabled={saving}
              className="flex-1 min-h-[44px] border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-[2] min-h-[44px] bg-amber-500 hover:bg-amber-400 active:bg-amber-600 disabled:opacity-60 text-white rounded-xl px-4 py-2.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
            >
              {saving ? "Guardando…" : "Guardar tipo de cambio"}
            </button>
          </div>
        </>
      )}
      </div>{/* /body */}
    </div>
  );
}
