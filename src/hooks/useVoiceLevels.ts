"use client";

import { useEffect, useRef, type RefObject } from "react";

// useVoiceLevels — single source of truth for audio amplitudes that
// downstream visualizers (orb / waveform) can read each frame.
//
// Arquitectura (consistente con la lección de Waveform.tsx):
//  - SAMPLING (analyser.getByteFrequencyData / lectura de externalAmpRef)
//    corre en setInterval(33ms), desacoplado del render. iOS Safari hace
//    throttle de rAF a 30fps en PWA standalone (WebKit bug 168837); leer
//    el analyser dentro del rAF produce jitter visible.
//  - El consumidor (orb shader / Waveform bars) lee los refs cada frame
//    e interpola con damping.
//
// Para output de la IA, NO usamos createMediaStreamSource sobre el remote
// stream de WebRTC (bug conocido — devuelve silencio). El parent del
// componente debe poblar `externalAmpRef.current` con la amplitud PCM del
// SDK Realtime via session.on("audio").

interface UseVoiceLevelsOptions {
  /** Activa el hook (pide mic, monta interval). */
  active: boolean;
  /** True cuando la IA está hablando. Cuando true, lee externalAmpRef. */
  speaking: boolean;
  /** Ref poblada por el parent con la amplitud RMS 0-1 del PCM de la IA. */
  externalAmpRef?: RefObject<number>;
}

interface UseVoiceLevelsResult {
  /** Amplitud del mic 0-1 (raw, sin smoothing). El consumidor suaviza. */
  inputLevelRef: RefObject<number>;
  /** Amplitud del PCM de la IA 0-1 (raw). */
  outputLevelRef: RefObject<number>;
}

const NOISE_GATE = 14;
const SAMPLE_INTERVAL_MS = 33;

export function useVoiceLevels({
  active,
  speaking,
  externalAmpRef,
}: UseVoiceLevelsOptions): UseVoiceLevelsResult {
  const inputLevelRef = useRef(0);
  const outputLevelRef = useRef(0);

  // AudioContext + analyser para el mic. Persisten entre re-renders pero
  // se limpian al unmount.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const setupMic = async () => {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = audioCtxRef.current ?? new Ctx();
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") await ctx.resume();

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
        // fftSize 512 con smoothing 0.55 = balance probado en LiveKit /
        // wavtools para voz móvil. Demasiados bins penalizan iOS sin
        // beneficio percibido para amplitud agregada.
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.55;
        source.connect(analyser);

        sourceRef.current = source;
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch (err) {
        console.warn("[useVoiceLevels] mic setup failed:", err);
      }
    };

    const sampleMic = () => {
      if (!analyserRef.current || !dataRef.current) {
        inputLevelRef.current = 0;
        return;
      }
      // Type cast por compatibilidad con tipos estrictos del DOM.
      analyserRef.current.getByteFrequencyData(
        dataRef.current as Uint8Array<ArrayBuffer>
      );
      const data = dataRef.current;
      let sum = 0;
      const scanLen = Math.min(60, data.length);
      for (let i = 1; i < scanLen; i++) sum += data[i];
      const avg = sum / (scanLen - 1);
      if (avg < NOISE_GATE) {
        inputLevelRef.current = 0;
      } else {
        // Normalizamos 0-255 → 0-1 con curva suave.
        inputLevelRef.current = Math.min(1, Math.pow(avg / 180, 0.85));
      }
    };

    const sampleOutput = () => {
      outputLevelRef.current = externalAmpRef?.current ?? 0;
    };

    const sample = () => {
      if (speaking && externalAmpRef) {
        // IA hablando: el orb reacciona a su PCM. Limpiamos input.
        sampleOutput();
        inputLevelRef.current = 0;
      } else {
        sampleMic();
        outputLevelRef.current = 0;
      }
    };

    setupMic().then(() => {
      if (cancelled) return;
      intervalId = setInterval(sample, SAMPLE_INTERVAL_MS);
    });

    // Resume AudioContext on visibility return (iOS suspends en background)
    // ONLY si la sesión sigue activa. Si la sesión terminó, NO resumimos
    // — eso re-engaging el indicador del mic en iOS aunque ya no estemos
    // grabando, que es exactamente el bug que el doctor reportó al
    // bloquear el celular / tomar screenshots.
    const onVisibility = () => {
      if (document.visibilityState === "visible" && active && !cancelled) {
        audioCtxRef.current?.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
      inputLevelRef.current = 0;
      outputLevelRef.current = 0;
      try {
        sourceRef.current?.disconnect();
      } catch {}
      sourceRef.current = null;
      analyserRef.current = null;
      dataRef.current = null;
      // CRÍTICO: detener los tracks del MediaStream (no solo desconectar
      // el AudioNode). Si no, iOS Safari mantiene el indicador naranja
      // del micrófono prendido aunque la sesión termine. Antes se hacía
      // solo en unmount; ahora también cuando active=false (post-handoff).
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      // Suspender (no cerrar) el contexto — close() libera recursos pero
      // hace que cualquier mic stream nuevo tarde en arrancar la próxima
      // vez. Suspend mantiene el contexto vivo pero deja de procesar.
      audioCtxRef.current?.suspend().catch(() => {});
    };
  }, [active, speaking, externalAmpRef]);

  // Unmount FINAL: cierra AudioContext completamente. Cualquier mic stream
  // ya fue stopped por el cleanup del effect anterior.
  useEffect(() => {
    const ctxRef = audioCtxRef;
    return () => {
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

  return { inputLevelRef, outputLevelRef };
}
