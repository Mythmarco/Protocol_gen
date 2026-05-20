"use client";

// Morphing AI orb — CSS-only, ligero (~0 KB JS overhead).
//
// Sirve para usos DECORATIVOS / "vibe checks" del estado idle: landing
// hero, loading overlays, thinking indicator dentro del chat. No es
// audio-reactivo — para eso ver OrbVoice.tsx (R3F + shader, lazy-loaded).
//
// Layers:
//   1. Soft halo (blurred conic gradient) — pulses opacity + scale
//   2. Morphing blob (border-radius keyframes) — slowly rotating gradient
//   3. Inner highlight — secondary pulse for depth
//
// Las animaciones (blobGlow, blobRotate, blobMorph, blobInner) están en
// globals.css.

interface Props {
  size?: number; // pixel size of the outer container
  className?: string;
}

export default function AIOrb({ size = 120, className = "" }: Props) {
  const halo = size * 1.1;
  const blob = size * 0.7;
  const inner = size * 0.35;

  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {/* 1. Outer halo (blurred conic gradient — brand amber + cool platinum) */}
      <div
        className="absolute rounded-full"
        style={{
          width: halo,
          height: halo,
          background:
            "conic-gradient(from 0deg, #f2b056, #ffe2b8, #c9c9cf, #f2b056, #e8e8ed, #f2b056)",
          filter: "blur(18px)",
          animation: "blobGlow 2.4s ease-in-out infinite, blobRotate 14s linear infinite",
        }}
      />

      {/* 2. Morphing blob — amber to platinum gradient */}
      <div
        className="relative"
        style={{
          width: blob,
          height: blob,
          background:
            "linear-gradient(135deg, #f2b056 0%, #d9943f 45%, #a8a8b0 100%)",
          borderRadius: "62% 38% 48% 52% / 50% 60% 40% 50%",
          animation:
            "blobMorph 4.2s ease-in-out infinite, blobRotate 12s linear infinite reverse",
          boxShadow:
            "0 10px 40px rgba(242, 176, 86, 0.35), 0 4px 20px rgba(168, 168, 176, 0.4), inset 0 0 30px rgba(255, 255, 255, 0.4)",
        }}
      >
        {/* 3. Inner highlight bubble */}
        <div
          className="absolute rounded-full"
          style={{
            width: inner,
            height: inner,
            top: "18%",
            left: "22%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 70%)",
            animation: "blobInner 2.8s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}
