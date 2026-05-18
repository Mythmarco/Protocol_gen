"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// Audio-reactive waveform.
//   - While `speaking` AND `externalAmpRef` provided: ignore mic, drive bars
//     from the ref (parent feeds amplitude from session.on("audio") events).
//   - Otherwise: WebAudio AnalyserNode on the user's mic.
//
// Why two modes: WebRTC remote audio streams can't be reliably analyzed in
// Chrome (createMediaStreamSource often returns silence). Tapping the SDK's
// PCM stream directly is much more reliable.

const COLORS = [
  "#3f3f46",
  "#27272a",
  "#18181b", // center bar — bass dominates voice
  "#27272a",
  "#3f3f46",
];

const BAND_GAIN = [1.0, 1.05, 1.15, 1.35, 1.6];
const NOISE_GATE = 16;
const SILENT_HEIGHT = 0.08;
const LERP = 0.32;

interface Props {
  active: boolean;
  speaking: boolean;
  externalAmpRef?: RefObject<number>; // 0..1 amplitude from the parent
  size?: "sm" | "md" | "lg";
}

export default function Waveform({
  active,
  speaking,
  externalAmpRef,
  size = "lg",
}: Props) {
  const [bars, setBars] = useState<number[]>(Array(5).fill(SILENT_HEIGHT));
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);
  const debugFramesRef = useRef(0);

  // External mode: when speaking + ref is provided, drive bars from the
  // PCM amplitude the parent computes from session.on("audio") events.
  useEffect(() => {
    if (!active || !speaking || !externalAmpRef) return;

    console.log("[waveform] external mode (AI speaking via session.on(audio))");

    const tick = () => {
      const amp = externalAmpRef.current ?? 0;
      // Distribute the single amplitude into 5 bars using phase-shifted
      // sine waves so they pulse together but don't move in unison. Gives
      // the natural "waveform" feel without needing per-frequency data.
      const t = performance.now() / 1000;
      const targets = COLORS.map((_, i) => {
        const wave = 0.55 + 0.45 * Math.sin(t * (2.8 + i * 0.55) + i * 1.3);
        // amp is 0..1 (mean abs of PCM16 / 32768). Voice levels are
        // usually 0.02-0.15 → we boost ×7 to map to visible bar heights.
        const peak = amp * 7 * wave;
        return Math.max(SILENT_HEIGHT, Math.min(1, peak));
      });

      debugFramesRef.current++;
      if (debugFramesRef.current % 60 === 0) {
        console.log(`[waveform] tick avg(amp×100)=${(amp * 100).toFixed(1)} src=ai`);
      }

      setBars((prev) => prev.map((b, i) => b + (targets[i] - b) * LERP));
      rafRef.current = requestAnimationFrame(tick);
    };
    debugFramesRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active, speaking, externalAmpRef]);

  // Mic mode: when listening (or no external ref available)
  useEffect(() => {
    if (!active) return;
    if (speaking && externalAmpRef) return; // external mode handles this

    let cancelled = false;

    async function setup() {
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
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);

        sourceRef.current = source;
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
        debugFramesRef.current = 0;

        console.log(`[waveform] connected source=mic (speaking=${speaking})`);

        const tick = () => {
          if (!analyserRef.current || !dataRef.current) return;
          analyserRef.current.getByteFrequencyData(
            dataRef.current as Uint8Array<ArrayBuffer>
          );
          const data = dataRef.current;

          let frameSum = 0;
          const scanLen = Math.min(60, data.length);
          for (let i = 1; i < scanLen; i++) frameSum += data[i];
          const frameAvg = frameSum / (scanLen - 1);

          debugFramesRef.current++;
          if (debugFramesRef.current % 60 === 0) {
            console.log(`[waveform] tick avg=${frameAvg.toFixed(1)} src=mic`);
          }

          let targets: number[];
          if (frameAvg < NOISE_GATE) {
            targets = Array(5).fill(SILENT_HEIGHT);
          } else {
            const groups = [
              avg(data, 1, 3),
              avg(data, 3, 7),
              avg(data, 7, 14),
              avg(data, 14, 26),
              avg(data, 26, 46),
            ];
            targets = groups.map((g, i) => {
              const gained = (g / 200) * BAND_GAIN[i];
              const curved = Math.pow(gained, 0.75);
              return Math.max(SILENT_HEIGHT, Math.min(1, curved));
            });
          }

          setBars((prev) => prev.map((b, i) => b + (targets[i] - b) * LERP));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        console.warn("[waveform] mic setup failed:", err);
      }
    }

    setup();

    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try {
        sourceRef.current?.disconnect();
      } catch {}
      sourceRef.current = null;
      analyserRef.current = null;
      dataRef.current = null;
    };
  }, [active, speaking, externalAmpRef]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  const containerHeight = size === "sm" ? 28 : size === "md" ? 40 : 56;
  const barWidth = size === "sm" ? 3 : size === "md" ? 4 : 5;

  return (
    <div
      className="flex items-center justify-center gap-1.5"
      style={{ height: containerHeight }}
    >
      {COLORS.map((color, i) => {
        const h = bars[i] ?? SILENT_HEIGHT;
        const heightPx = Math.max(barWidth, h * containerHeight);
        return (
          <div
            key={i}
            className="rounded-full"
            style={{
              width: barWidth,
              height: heightPx,
              background: `linear-gradient(180deg, ${color} 0%, #0a0a0a 50%, ${color} 100%)`,
              transition: "height 80ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        );
      })}
    </div>
  );
}

function avg(arr: Uint8Array, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) {
    sum += arr[i];
    n++;
  }
  return n ? sum / n : 0;
}
