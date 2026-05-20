"use client";

import { useEffect, useRef, useState } from "react";
import AIOrb from "../AIOrb";

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

interface Props {
  phase: "thinking" | "protocol";
}

export default function ThinkingIndicator({ phase }: Props) {
  const [labelIdx, setLabelIdx] = useState(0);
  const [labelVisible, setLabelVisible] = useState(true);
  const labels = THINKING_LABELS[phase];
  const labelsLenRef = useRef(labels.length);

  useEffect(() => {
    // Sincronizamos el ref DENTRO del effect (no durante render — eso
    // dispara el lint react-hooks). Los timers leen el valor actual sin
    // tener que volver a suscribirse cuando cambia `labels.length`.
    labelsLenRef.current = labels.length;
    // Reset visible-state al cambiar fase. queueMicrotask saca el setState
    // del cuerpo síncrono del effect (regla set-state-in-effect).
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLabelIdx(0);
      setLabelVisible(true);
    });

    const interval = window.setInterval(() => {
      if (cancelled) return;
      setLabelVisible(false);
      window.setTimeout(() => {
        if (cancelled) return;
        setLabelIdx((i) => (i + 1) % labelsLenRef.current);
        setLabelVisible(true);
      }, 220);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
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
