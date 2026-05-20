"use client";

import AIOrb from "../AIOrb";

const QUICK_STARTS = [
  "Paciente Diego de la Garza, 87 kg, 1.76 m, 37 años, mes 2 pérdida de peso visceral",
  "Nuevo protocolo mes 1 para Ana López, 68 kg, 1.65 m, 42 años, energía y recuperación",
];

interface Props {
  doctorFirstName: string;
  onPick: (mode: "text" | "voice") => void;
  onQuickStart: (prompt: string) => void;
}

export default function LandingHero({ doctorFirstName, onPick, onQuickStart }: Props) {
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
