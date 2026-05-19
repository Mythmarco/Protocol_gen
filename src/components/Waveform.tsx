"use client";

import { useEffect, useRef, type RefObject } from "react";

// Audio-reactive waveform.
//
// Arquitectura (lección aprendida vía investigación de patrones en
// LiveKit Agents UI, wavtools, OpenAI realtime-console):
//
//   - Muestreo (analyser → bandas) corre en setInterval(33ms), DESACOPLADO
//     del render. iOS Safari hace throttle de requestAnimationFrame a 30fps
//     (peor en standalone PWA, ver WebKit bug 168837), así que si lees el
//     analyser dentro del rAF obtienes jitter visual.
//   - Render corre en su propio rAF y solo interpola + escribe directamente
//     a `style.height` de los <div> de las barras via refs. No setState en
//     el hot path → cero reconciliación de React.
//   - Damping exponencial (factor 0.25) absorbe el jitter de iOS.
//   - fftSize 512 + smoothing 0.55: balance probado para voz en móvil.
//
// Para output de IA (when `speaking` + `externalAmpRef`): el SDK de
// @openai/agents emite chunks PCM via session.on("audio"); el parente
// calcula amplitud y la pone en externalAmpRef. Aquí mantenemos un ring
// buffer de las últimas 5 muestras para "fake-bands" convincentes sin
// pagar el costo de FFT sobre PCM crudo.

const COLORS = [
  "#3f3f46",
  "#27272a",
  "#18181b", // bar central — bass dominates voice
  "#27272a",
  "#3f3f46",
];

const BAND_COUNT = 5;
const SILENT_HEIGHT = 0.08;
const DAMP = 0.25;            // damping del render — más alto = más sensible
const NOISE_GATE = 14;        // <14 byte avg en el analyser → tratamos como silencio
const BAND_GAIN = [1.0, 1.05, 1.15, 1.35, 1.55];
const SAMPLE_INTERVAL_MS = 33; // ~30Hz, suficiente para voz en móvil
const AI_AMP_BOOST = 7;       // mapea 0..0.15 RMS típico → 0..1 bar height

interface Props {
  active: boolean;
  speaking: boolean;
  externalAmpRef?: RefObject<number>; // 0..1 amplitud del PCM del AI
  size?: "sm" | "md" | "lg";
}

export default function Waveform({
  active,
  speaking,
  externalAmpRef,
  size = "lg",
}: Props) {
  // Refs a los <div> de las barras — escribimos directo a su style.
  const barRefs = useRef<Array<HTMLDivElement | null>>(
    Array(BAND_COUNT).fill(null)
  );

  // Estado interno SOLO en refs (no React state) para evitar reconciliación.
  // `targetBands`: lo último muestreado del analyser / amp del AI.
  // `displayBands`: lo que realmente está dibujado, interpolado con damping.
  const targetBandsRef = useRef<number[]>(
    Array(BAND_COUNT).fill(SILENT_HEIGHT)
  );
  const displayBandsRef = useRef<number[]>(
    Array(BAND_COUNT).fill(SILENT_HEIGHT)
  );
  // Ring buffer de amplitudes recientes para repartir el audio del AI en
  // múltiples "bandas" sin frequency-domain analysis.
  const aiAmpRingRef = useRef<number[]>(Array(BAND_COUNT).fill(0));

  // AudioContext + analyser para el mic.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  // Dimensiones por tamaño — se calculan una vez y se mantienen estables.
  const containerHeight = size === "sm" ? 28 : size === "md" ? 40 : 56;
  const barWidth = size === "sm" ? 3 : size === "md" ? 4 : 5;

  // ── Sampling loop: corre cada SAMPLE_INTERVAL_MS, desacoplado del render.
  //    Decide entre fuente AI (externalAmpRef) o mic (analyser).
  useEffect(() => {
    if (!active) return;

    const usingAI = speaking && externalAmpRef;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const setupMic = async () => {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = audioCtxRef.current ?? new Ctx();
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        const aliveMic = micStreamRef.current
          ?.getAudioTracks()
          .some((t) => t.readyState === "live");
        if (!aliveMic) {
          micStreamRef.current?.getTracks().forEach((t) => t.stop());
          micStreamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        }
        if (cancelled) return;

        const source = ctx.createMediaStreamSource(micStreamRef.current!);
        const analyser = ctx.createAnalyser();
        // fftSize 512 = 256 bins; suficiente para 5 bandas y barato en iOS.
        analyser.fftSize = 512;
        // smoothing alto = más latencia; 0.55 da respuesta inmediata sin saltar.
        analyser.smoothingTimeConstant = 0.55;
        source.connect(analyser);

        sourceRef.current = source;
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
        console.log("[waveform] mic source connected (fftSize=512)");
      } catch (err) {
        console.warn("[waveform] mic setup failed:", err);
      }
    };

    const sampleMic = () => {
      if (!analyserRef.current || !dataRef.current) return;
      // Cast workaround: el typing de getByteFrequencyData en algunas
      // versiones de TS pide ArrayBuffer; nuestro Uint8Array está OK.
      analyserRef.current.getByteFrequencyData(
        dataRef.current as Uint8Array<ArrayBuffer>
      );
      const data = dataRef.current;

      // Noise gate: si todo el frame está debajo del umbral, baja a silencio.
      let frameSum = 0;
      const scanLen = Math.min(60, data.length);
      for (let i = 1; i < scanLen; i++) frameSum += data[i];
      const frameAvg = frameSum / (scanLen - 1);

      if (frameAvg < NOISE_GATE) {
        for (let b = 0; b < BAND_COUNT; b++) {
          targetBandsRef.current[b] = SILENT_HEIGHT;
        }
        return;
      }

      // 5 bandas log-spaced: bass, low-mid, mid, high-mid, high.
      const ranges: [number, number][] = [
        [1, 3],
        [3, 7],
        [7, 14],
        [14, 26],
        [26, 46],
      ];
      for (let b = 0; b < BAND_COUNT; b++) {
        const [lo, hi] = ranges[b];
        const end = Math.min(hi, data.length);
        let s = 0;
        let n = 0;
        for (let i = lo; i < end; i++) {
          s += data[i];
          n++;
        }
        const avg = n ? s / n : 0;
        const gained = (avg / 200) * BAND_GAIN[b];
        const curved = Math.pow(gained, 0.75);
        targetBandsRef.current[b] = Math.max(
          SILENT_HEIGHT,
          Math.min(1, curved)
        );
      }
    };

    const sampleAI = () => {
      const amp = externalAmpRef?.current ?? 0;
      // Rota el ring buffer: shift right + insertar nueva muestra en [0].
      const ring = aiAmpRingRef.current;
      for (let i = ring.length - 1; i > 0; i--) ring[i] = ring[i - 1];
      ring[0] = amp;

      // Mapea cada banda a una posición del ring. Bandas exteriores van más
      // "tarde" — efecto de eco visual que se ve natural.
      // Distribución: [centro_más_reciente, mid, edge, edge_más_lejano]
      const ringIdx = [2, 1, 0, 1, 2];
      for (let b = 0; b < BAND_COUNT; b++) {
        const sample = ring[ringIdx[b]] ?? 0;
        // amp típica del PCM (mean abs / 32768) está en 0..0.15. ×7 mapea a 0..1.
        const h = sample * AI_AMP_BOOST;
        targetBandsRef.current[b] = Math.max(
          SILENT_HEIGHT,
          Math.min(1, h)
        );
      }
    };

    if (usingAI) {
      console.log("[waveform] external mode (AI PCM via session.on(audio))");
      intervalId = setInterval(sampleAI, SAMPLE_INTERVAL_MS);
    } else {
      setupMic().then(() => {
        if (cancelled) return;
        intervalId = setInterval(sampleMic, SAMPLE_INTERVAL_MS);
      });
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      // Reset targets a silencio para que el render baje las barras suave.
      for (let b = 0; b < BAND_COUNT; b++) {
        targetBandsRef.current[b] = SILENT_HEIGHT;
      }
      aiAmpRingRef.current.fill(0);

      // Solo desconectar mic resources si estábamos en mic mode.
      if (!usingAI) {
        try {
          sourceRef.current?.disconnect();
        } catch {}
        sourceRef.current = null;
        analyserRef.current = null;
        dataRef.current = null;
      }
    };
  }, [active, speaking, externalAmpRef]);

  // ── Render loop: corre su propio rAF, solo interpola y muta el DOM
  //    directamente. No re-renderiza React.
  useEffect(() => {
    if (!active) return;
    let rafId: number | null = null;

    const draw = () => {
      const display = displayBandsRef.current;
      const target = targetBandsRef.current;
      for (let b = 0; b < BAND_COUNT; b++) {
        display[b] += (target[b] - display[b]) * DAMP;
        const node = barRefs.current[b];
        if (node) {
          const h = Math.max(barWidth, display[b] * containerHeight);
          // Escribir en px directo evita layout thrashing por units.
          node.style.height = h + "px";
        }
      }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [active, barWidth, containerHeight]);

  // Resume AudioContext cuando el PWA vuelve del background (iOS lo suspende).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        audioCtxRef.current?.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  return (
    <div
      className="flex items-center justify-center gap-1.5"
      style={{ height: containerHeight }}
    >
      {COLORS.map((color, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="rounded-full"
          style={{
            width: barWidth,
            height: SILENT_HEIGHT * containerHeight,
            background: `linear-gradient(180deg, ${color} 0%, #0a0a0a 50%, ${color} 100%)`,
            transition: "height 60ms cubic-bezier(0.22, 1, 0.36, 1)",
            willChange: "height",
          }}
        />
      ))}
    </div>
  );
}
