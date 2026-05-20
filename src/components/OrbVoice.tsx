"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/refs */
// React 19 lint rules sobre "no mutar después de render" / "no acceder refs
// en render" no aplican aquí: useFrame de R3F corre FUERA del ciclo de
// render de React (es el rAF loop interno de three.js). Mutar uniforms y
// pasar uniformsRef.current al ShaderMaterial es el patrón intencional de
// R3F desde hace 5 años. Disable es justificado y aislado a este archivo.

// Audio-reactive AI orb (R3F + GLSL shader).
//
// Visual = una IcosahedronGeometry con vertex displacement controlado por
// simplex noise + amplitud RMS. Fragment shader pinta un gradiente radial
// con fresnel rim. Mismo orb para todos los estados; solo cambian los
// colores via uniforms que interpolamos suavemente al cambiar de state.
//
// Patrón inspirado en ElevenLabs Orb, Vapi y Gemini Live — consenso 2026
// para voice agents: un solo orb que reemplaza a "orb + waveform" separados.
//
// IMPORTANTE — anti-spike:
// El bug "se ven picos angulares" venía de displacement alto (0.73 max) con
// noise de alta frecuencia (pos * 2.8). Cada vértice tirado lejos de la
// esfera, en direcciones distintas, generaba spikes radiales visibles en
// la silueta. La fix es noise de BAJA frecuencia (bultos grandes, sin
// puntos) y displacement máximo bajo (0.25). El orb sigue "respirando"
// pero los bultos son suaves, tipo nube de plasma, no espinas.
//
// Performance: sampling de amplitud NUNCA ocurre aquí — lo hace el hook
// useVoiceLevels desacoplado del rAF. useFrame solo lee refs y escribe
// uniforms (sin setState → sin re-render React).

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, type RefObject } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "speaking" | "thinking";

interface OrbVoiceProps {
  /**
   * Tamaño en px del canvas (orb llena ~70% del canvas para dejar aire
   * suficiente al respirar).
   */
  size?: number;
  className?: string;
  /**
   * Estado actual del agente. Solo afecta colores; la geometría reacciona
   * a inputLevelRef/outputLevelRef.
   */
  state?: OrbState;
  /** Amplitud del mic 0-1 (poblada por useVoiceLevels). */
  inputLevelRef?: RefObject<number>;
  /** Amplitud del PCM de la IA 0-1. */
  outputLevelRef?: RefObject<number>;
}

// Paleta por estado — RGB 0-1 para GLSL. Saturación REAL para que el orb
// destaque visiblemente contra el fondo cream (#f5f3f1) del app.
const COLORS: Record<OrbState, { a: [number, number, number]; b: [number, number, number] }> = {
  // Idle: ámbar cálido suave → platino. Visible pero no agresivo.
  idle:      { a: [0.95, 0.69, 0.34], b: [0.66, 0.66, 0.69] },
  // Listening (doctor habla): cyan profundo → cyan claro. "Recibiendo".
  listening: { a: [0.22, 0.65, 0.92], b: [0.62, 0.86, 1.00] },
  // Speaking (IA responde): ámbar cálido → coral (paleta marca). Activo.
  speaking:  { a: [0.95, 0.55, 0.20], b: [0.98, 0.78, 0.42] },
  // Thinking: violeta-azulado → lavanda. Contemplativo, diferenciado.
  thinking:  { a: [0.42, 0.40, 0.78], b: [0.72, 0.71, 0.94] },
};

// Vertex shader: simplex noise 3D adaptado de https://github.com/ashima/webgl-noise (MIT).
// Displacement orgánico SUAVE — bultos grandes, no espinas.
const vertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vDisp;

uniform float uTime;
uniform float uAmp;

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m; return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

void main() {
  vec3 pos = position;
  // Noise de BAJA frecuencia → bultos grandes y suaves (tipo nube), no
  // espinas. Dos octavas pero la segunda muy bajada (0.15 vs 0.5 antes)
  // para que la silueta no muestre detalles finos.
  float t = uTime;
  float n1 = snoise(pos * 0.9 + t * 0.35);
  float n2 = snoise(pos * 1.7 + t * 0.55) * 0.15;
  float n  = n1 + n2;
  // Displacement MUY contenido — antes era 0.18+0.55*uAmp (max 0.73 en
  // amplitud 1.0). Ahora 0.05+0.20*uAmp (max 0.25). 3x menor pero sigue
  // siendo claramente visible. Esto es lo que mata los picos.
  float disp = n * (0.05 + uAmp * 0.20);
  vec3 displaced = pos + normal * disp;
  vDisp = disp;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vDisp;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uAmp;

void main() {
  // Dos fresnels: uno para la transición de color (suave), otro para el
  // alpha de borde (decay más agresivo para que el orb se funda con el
  // fondo sin línea visible — el patrón de ElevenLabs/Pi).
  float ndv = max(dot(vNormal, vViewDir), 0.0);
  float fresnelColor = pow(1.0 - ndv, 2.2);
  float fresnelEdge = pow(1.0 - ndv, 4.5);

  // Transición de color centro → borde, modulada por amplitud para que el
  // brillo del rim crezca al hablar.
  vec3 base = mix(uColorA, uColorB, fresnelColor);
  vec3 glow = vec3(1.0) * fresnelColor * (0.30 + uAmp * 0.45);
  vec3 col = base + glow * 0.55;
  col += vec3(vDisp * 0.6); // realza zonas con bulto positivo → look "nube"

  // Alpha decae fuerte en el borde extremo. Sin línea hard del mesh.
  // Centro semi-translúcido (0.92) para look "vidrio iridiscente".
  float alpha = 0.92 - fresnelEdge * 0.55;
  gl_FragColor = vec4(col, alpha);
}
`;

// Mutación IN-PLACE (no devuelve array nuevo). React 19 lint se queja si
// reasignamos `ref.current = [...]` en cada frame; mutar el array existente
// es semánticamente igual (ref values son mutables por diseño).
function lerp3InPlace(
  out: [number, number, number],
  to: [number, number, number],
  t: number
): void {
  out[0] += (to[0] - out[0]) * t;
  out[1] += (to[1] - out[1]) * t;
  out[2] += (to[2] - out[2]) * t;
}

interface OrbMeshProps {
  state: OrbState;
  inputLevelRef?: RefObject<number>;
  outputLevelRef?: RefObject<number>;
}

function OrbMesh({ state, inputLevelRef, outputLevelRef }: OrbMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  // Refs (no useMemo) — los uniforms se mutan cada frame y el React 19 lint
  // prohíbe mutar resultados de useMemo. Refs son explicitly mutables.
  const uniformsRef = useRef({
    uTime: { value: 0 },
    uAmp: { value: 0 },
    uColorA: {
      value: new THREE.Color(
        COLORS.idle.a[0],
        COLORS.idle.a[1],
        COLORS.idle.a[2]
      ),
    },
    uColorB: {
      value: new THREE.Color(
        COLORS.idle.b[0],
        COLORS.idle.b[1],
        COLORS.idle.b[2]
      ),
    },
  });
  const dampedAmp = useRef(0);
  const dampedColorA = useRef<[number, number, number]>([...COLORS.idle.a]);
  const dampedColorB = useRef<[number, number, number]>([...COLORS.idle.b]);
  const idleAmpClock = useRef(0);

  // useFrame corre FUERA del render de React — es el rAF loop de R3F.
  // Mutar uniforms y refs aquí es el patrón intencional; el lint
  // react-hooks/set-state-in-effect no entiende esta API y reporta falsos
  // positivos. Lo silenciamos con justificación documentada.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useFrame((_, delta) => {
    let targetAmp = Math.max(
      inputLevelRef?.current ?? 0,
      outputLevelRef?.current ?? 0
    );
    if (state === "thinking" || state === "idle") {
      // Fake amplitude para idle/thinking — orb "respira" sin audio.
      // Bajado a 0.40±0.18 (era 0.55±0.25): respiración tranquila, no
      // espasmódica. Con el displacement nuevo (0.20 max) esto produce
      // bultos visibles pero suaves.
      idleAmpClock.current += delta;
      const t = idleAmpClock.current;
      const fake = 0.40 + 0.15 * Math.sin(t * 1.4) + 0.04 * Math.sin(t * 3.5);
      targetAmp = Math.max(targetAmp, fake);
    }
    dampedAmp.current += (targetAmp - dampedAmp.current) * 0.15;

    const tgt = COLORS[state];
    lerp3InPlace(dampedColorA.current, tgt.a, 0.06);
    lerp3InPlace(dampedColorB.current, tgt.b, 0.06);

    uniformsRef.current.uTime.value += delta;
    uniformsRef.current.uAmp.value = dampedAmp.current;
    uniformsRef.current.uColorA.value.setRGB(
      dampedColorA.current[0],
      dampedColorA.current[1],
      dampedColorA.current[2]
    );
    uniformsRef.current.uColorB.value.setRGB(
      dampedColorB.current[0],
      dampedColorB.current[1],
      dampedColorB.current[2]
    );

    if (meshRef.current) {
      // Scale rango contenido (1.0 → 1.08, era 1.20). El "respirar" sale
      // del displacement, no del scale — así no recortamos contra el
      // borde del canvas al respirar. Rotación lenta para que el patrón
      // de bultos se mueva en pantalla.
      const scale = 1.0 + dampedAmp.current * 0.08;
      meshRef.current.scale.setScalar(scale);
      meshRef.current.rotation.y += delta * 0.12;
      meshRef.current.rotation.x += delta * 0.04;
    }
  });

  return (
    <mesh ref={meshRef}>
      {/* Subdiv 8 = ~5000 vértices, silueta circular real. Con
          displacement bajo (max 0.25) y noise de baja frecuencia, NO
          aparecen espinas en la silueta — solo bultos suaves. */}
      <icosahedronGeometry args={[1, 8]} />
      <shaderMaterial
        uniforms={uniformsRef.current}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}

export default function OrbVoice({
  size = 120,
  className = "",
  state = "idle",
  inputLevelRef,
  outputLevelRef,
}: OrbVoiceProps) {
  return (
    <div
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    >
      <Canvas
        // dpr 2 en Retina + antialias true → silueta crisp y sin escalones
        // poligonales. Critical para que los bordes no se vean "rough".
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        // Camera más lejos (z=3.0 vs 2.6) + FOV más cerrado (50 vs 55) →
        // más aire alrededor del orb para que el respirar + bultos no
        // recorten contra el borde superior del canvas.
        camera={{ position: [0, 0, 3.0], fov: 50 }}
        frameloop="always"
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[2, 3, 4]} intensity={0.7} />
        <OrbMesh
          state={state}
          inputLevelRef={inputLevelRef}
          outputLevelRef={outputLevelRef}
        />
      </Canvas>
    </div>
  );
}
