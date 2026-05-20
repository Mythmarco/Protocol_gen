"use client";

import { useState } from "react";
import type { HistoryItem } from "./types";

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

interface Props {
  items: HistoryItem[];
  onClose: () => void;
  onPick: (item: HistoryItem) => void;
}

export default function MobileHistoryScreen({ items, onClose, onPick }: Props) {
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
