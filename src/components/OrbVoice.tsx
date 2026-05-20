"use client";

// Audio-reactive voice orb. Visualmente IDÉNTICO al AIOrb del home
// (CSS-only morphing blob) pero con dos cosas extra:
//
//   1) Paleta cambia según el estado del agente (idle/listening/speaking/
//      thinking). Cada estado tiene gradiente propio (ámbar, cyan, naranja
//      vibrante, violeta).
//
//   2) Reactividad de audio: un rAF loop lee inputLevelRef y outputLevelRef
//      (poblados por useVoiceLevels) y actualiza inline styles del blob/
//      halo (scale, opacity, animation-duration). Esto crea movimiento
//      EXAGERADO pero suave que coincide con el habla — el blob "respira"
//      con la voz del doctor o de la IA, no con un timer abstracto.
//
// ¿Por qué CSS-only y no R3F como antes? El doctor reportó que la versión
// shader se veía "fea" y prefiere el look del home (blob morph orgánico).
// CSS también elimina ~180KB de three.js del bundle de voz.

import { useEffect, useRef, type RefObject } from "react";

export type OrbState = "idle" | "listening" | "speaking" | "thinking";

interface OrbVoiceProps {
  size?: number;
  className?: string;
  /** Estado actual del agente — define la paleta de colores. */
  state?: OrbState;
  /** Amplitud del mic 0-1 (poblada por useVoiceLevels). */
  inputLevelRef?: RefObject<number>;
  /** Amplitud del PCM de la IA 0-1. */
  outputLevelRef?: RefObject<number>;
}

// Gradientes por estado. La estructura es la misma — solo cambian los
// colores. Mantenemos el patrón amber→intermedio→neutro del home para que
// se sienta "la misma marca" en cada estado.
//   - haloGrad: conic gradient del halo blureado (5 stops)
//   - blobGrad: lineal del blob central
//   - shadowAmber/shadowCool: glow colorido del box-shadow
const PALETTES: Record<
  OrbState,
  {
    halo: string;
    blob: string;
    shadow1: string;
    shadow2: string;
  }
> = {
  idle: {
    halo: "conic-gradient(from 0deg, #f2b056, #ffe2b8, #c9c9cf, #f2b056, #e8e8ed, #f2b056)",
    blob: "linear-gradient(135deg, #f2b056 0%, #d9943f 45%, #a8a8b0 100%)",
    shadow1: "rgba(242, 176, 86, 0.35)",
    shadow2: "rgba(168, 168, 176, 0.40)",
  },
  listening: {
    // Doctor habla: cyan + cielo + blanco. Frío, "recibiendo".
    halo: "conic-gradient(from 0deg, #4fbcff, #aee3ff, #d9f1ff, #4fbcff, #e5f3ff, #4fbcff)",
    blob: "linear-gradient(135deg, #4fbcff 0%, #3a8fd6 45%, #b6d8ee 100%)",
    shadow1: "rgba(79, 188, 255, 0.40)",
    shadow2: "rgba(58, 143, 214, 0.35)",
  },
  speaking: {
    // IA habla: naranja vibrante + ámbar + coral. Activo, cálido.
    halo: "conic-gradient(from 0deg, #ff8a3d, #ffc079, #ffe2b8, #ff8a3d, #ffd1a3, #ff8a3d)",
    blob: "linear-gradient(135deg, #ff8a3d 0%, #e0671b 45%, #f2b056 100%)",
    shadow1: "rgba(255, 138, 61, 0.45)",
    shadow2: "rgba(224, 103, 27, 0.35)",
  },
  thinking: {
    // Pensando: violeta + magenta + lavanda. Contemplativo.
    halo: "conic-gradient(from 0deg, #8a6bd1, #c2a8ee, #e8defc, #8a6bd1, #d9c6f5, #8a6bd1)",
    blob: "linear-gradient(135deg, #8a6bd1 0%, #6a48b8 45%, #c2a8ee 100%)",
    shadow1: "rgba(138, 107, 209, 0.40)",
    shadow2: "rgba(106, 72, 184, 0.35)",
  },
};

export default function OrbVoice({
  size = 120,
  className = "",
  state = "idle",
  inputLevelRef,
  outputLevelRef,
}: OrbVoiceProps) {
  // Tamaños relativos — mismas proporciones que AIOrb para que se vean
  // idénticos en home y voice mode.
  const halo = size * 1.1;
  const blob = size * 0.7;
  const inner = size * 0.35;

  // Refs al DOM para mutar transform/opacity por frame sin re-renderizar
  // React. Patrón estándar para animaciones audio-reactivas: el ciclo de
  // render de React es demasiado caro para 60fps de updates de estilo.
  const haloRef = useRef<HTMLDivElement | null>(null);
  const blobRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const dampedAmp = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // Tomamos el max entre input (mic) y output (PCM de la IA). Esto
      // asegura que el orb se mueva con QUIEN esté hablando.
      const target = Math.max(
        inputLevelRef?.current ?? 0,
        outputLevelRef?.current ?? 0
      );

      // Damping suave (0.15) para que el orb no se sienta nervioso —
      // sigue la voz con ~100ms de smoothing, lo justo para ser percibido
      // como "responde a mí" sin tics bruscos.
      dampedAmp.current += (target - dampedAmp.current) * 0.15;
      const a = dampedAmp.current;

      if (blobRef.current) {
        // Scale exagerado pero contenido: 1.0 → 1.14. Más grande que el
        // 1.08 del orb shader de la versión anterior — "más exagerado".
        // Combinado con el morph CSS (border-radius keyframes) se siente
        // orgánico, no como un bombeo regular.
        const scale = 1.0 + a * 0.14;
        blobRef.current.style.transform = `scale(${scale.toFixed(3)})`;
        // Brillo extra cuando hay audio — el blob "se ilumina" al hablar.
        const bright = 1.0 + a * 0.15;
        blobRef.current.style.filter = `brightness(${bright.toFixed(3)})`;
      }
      if (haloRef.current) {
        // El halo CRECE y se ABRE en opacidad con el audio. Aquí está la
        // mayor parte del "movimiento exagerado pero elegante" — el halo
        // es difuso (blur 18px) así que escalarlo no se siente brusco.
        const haloScale = 1.0 + a * 0.35;
        const haloOpacity = 0.45 + a * 0.50;
        haloRef.current.style.transform = `scale(${haloScale.toFixed(3)})`;
        haloRef.current.style.opacity = haloOpacity.toFixed(3);
      }
      if (innerRef.current) {
        // El highlight interno también se intensifica con audio — añade
        // sensación de "pulso vivo" desde el centro del orb.
        const innerOpacity = 0.5 + a * 0.45;
        innerRef.current.style.opacity = innerOpacity.toFixed(3);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inputLevelRef, outputLevelRef]);

  const palette = PALETTES[state];

  // animation-duration del morph: más lento en idle (4.2s = misma cadencia
  // del home), más rápido en speaking/listening (2.8s) — el blob morphea
  // visiblemente más rápido cuando hay actividad. thinking se mantiene
  // contemplativo (3.6s).
  const morphDuration =
    state === "speaking" ? "2.6s" :
    state === "listening" ? "2.8s" :
    state === "thinking" ? "3.6s" :
    "4.2s";

  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {/* 1. Halo difuso conic-gradient. Sin animation-rotate aquí —
          dejamos solo el rAF para que la rotación venga del audio. NO,
          mantenemos también el rotate base para que en idle puro siga
          girando despacio (sin esto el orb en idle se ve estático).
          La opacidad se sobreescribe desde rAF cada frame, eso pisa el
          keyframe blobGlow — está bien, queremos el control reactivo. */}
      <div
        ref={haloRef}
        className="absolute rounded-full"
        style={{
          width: halo,
          height: halo,
          background: palette.halo,
          filter: "blur(18px)",
          opacity: 0.45,
          animation: "blobRotate 14s linear infinite",
          transition: "background 600ms ease-out",
        }}
      />

      {/* 2. Blob central — gradiente del estado + morph CSS. El scale lo
          mete el rAF. La rotación reverse y morph siguen siendo CSS
          animation porque son cíclicas y no necesitan tracking de audio. */}
      <div
        ref={blobRef}
        className="relative"
        style={{
          width: blob,
          height: blob,
          background: palette.blob,
          borderRadius: "62% 38% 48% 52% / 50% 60% 40% 50%",
          animation: `blobMorph ${morphDuration} ease-in-out infinite, blobRotate 12s linear infinite reverse`,
          boxShadow: `0 10px 40px ${palette.shadow1}, 0 4px 20px ${palette.shadow2}, inset 0 0 30px rgba(255, 255, 255, 0.4)`,
          // Cambio de paleta = transición suave (600ms) en background y
          // box-shadow. Sin esto, cambiar de idle→listening se sentía como
          // un cut.
          transition: "background 600ms ease-out, box-shadow 600ms ease-out",
        }}
      >
        {/* 3. Inner highlight — blanco translúcido. La animation interna
            (blobInner) sigue pulsando; rAF solo modula opacidad con audio. */}
        <div
          ref={innerRef}
          className="absolute rounded-full"
          style={{
            width: inner,
            height: inner,
            top: "18%",
            left: "22%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 70%)",
            opacity: 0.6,
            animation: "blobInner 2.8s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}
