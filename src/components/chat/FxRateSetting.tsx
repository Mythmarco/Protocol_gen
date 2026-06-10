"use client";

import { useEffect, useState } from "react";

// Editor del tipo de cambio MXN/USD para cotizaciones en USD. Se muestra
// en el sheet de Cuenta (móvil + desktop). El valor se persiste en
// protocol_gen_settings vía /api/fx. Si el doctor no tiene valor en BD,
// la app cae al env PEPTIDES_MXN_PER_USD o al default 18.5 — el badge
// "Tu valor / Default" se lo indica.

type FxResponse = { rate: number; source: "user" | "env" | "default" };

interface Props {
  /** Compact en el sheet móvil (sin label de sección). */
  variant?: "default" | "compact";
}

export default function FxRateSetting({ variant = "default" }: Props) {
  const [data, setData] = useState<FxResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          // Si el endpoint falla, mostramos el default 18.5 con badge para
          // que el doctor sepa que hubo problema pero no bloqueamos la UI.
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
      setError("Debe estar entre 10 y 40");
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
        setError(body?.error || `Error ${res.status}`);
        return;
      }
      setData({ rate: body.rate, source: "user" });
      setDraft(Number(body.rate).toFixed(2));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
      setSaving(false);
    }
  };

  const sourceLabel = (s: FxResponse["source"]) => {
    if (s === "user") return { txt: "Tu valor", bg: "bg-emerald-50", fg: "text-emerald-700" };
    if (s === "env") return { txt: "Default Vercel", bg: "bg-amber-50", fg: "text-amber-700" };
    return { txt: "Fallback", bg: "bg-stone-100", fg: "text-stone-600" };
  };

  if (!data) {
    return (
      <div className="text-xs text-stone-400">Cargando tipo de cambio…</div>
    );
  }

  const badge = sourceLabel(data.source);

  return (
    <div>
      {variant === "default" && (
        <div className="text-xs text-stone-500 uppercase tracking-wider mb-1">
          Tipo de cambio MXN/USD
        </div>
      )}

      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-base font-semibold text-stone-800">
              {data.rate.toFixed(2)}
            </span>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.bg} ${badge.fg}`}
              title="De dónde viene este tipo de cambio"
            >
              {badge.txt}
            </span>
          </div>
          <button
            onClick={() => {
              setEditing(true);
              setError(null);
            }}
            className="text-xs font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-full px-3 py-1 transition-colors"
          >
            Editar
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="10"
              max="40"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-base font-semibold text-stone-800 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
              placeholder="18.50"
              aria-label="Tipo de cambio MXN por USD"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg px-3 py-2 transition-colors"
            >
              {saving ? "…" : "Guardar"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft(data.rate.toFixed(2));
                setError(null);
              }}
              disabled={saving}
              className="text-xs text-stone-500 hover:text-stone-700 px-2 py-2"
            >
              Cancelar
            </button>
          </div>
          <div className="text-[11px] text-stone-500 mt-1.5 leading-snug">
            Se aplica a cotizaciones en USD. El PDF muestra el valor usado.
          </div>
          {error && (
            <div className="text-[11px] text-red-600 mt-1 font-medium">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
