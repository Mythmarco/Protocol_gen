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
// Performance: sampling de amplitud NUNCA ocurre aquí — lo hace el hook
// useVoiceLevels desacoplado del rAF. useFrame solo lee refs y escribe
// uniforms (sin setState → sin re-render React).

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, type RefObject } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "speaking" | "thinking";

interface OrbVoiceProps {
  /**
   * Tamaño en px del canvas (orb llena ~80% del canvas).
   * Default 120 para mantener compatibilidad con el componente viejo.
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
// destaque visiblemente contra el fondo cream (#f5f3f1) del app. La versión
// anterior usaba grises casi-blancos que se confundían con el fondo y
// hacían parecer que el orb era estático.
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
// El displacement combina amplitud uniform (uAmp) y simplex 3D + tiempo
// lento para "respiración" orgánica.
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
  // Base displacement = noise * (idle floor + amp). Idle floor de 0.12 da
  // movimiento visible sin audio. Amp-driven hasta 0.45 = orb dramático al
  // hablar (era 0.06+0.35 antes, muy sutil para verse a distancia).
  float noiseScale = 1.6 + uAmp * 0.4;
  float n = snoise(pos * noiseScale + uTime * 0.45);
  float disp = n * (0.12 + uAmp * 0.45);
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
  // Fresnel rim — más brillo al borde según el ángulo de vista.
  float fresnel = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.6);
  vec3 base = mix(uColorA, uColorB, fresnel);
  // Acento de brillo en el borde, más fuerte con amplitud (treble feel).
  vec3 glow = vec3(1.0) * fresnel * (0.35 + uAmp * 0.45);
  vec3 col = base + glow * 0.6;
  // Sutil tinte por displacement (zonas elevadas más claras).
  col += vec3(vDisp * 0.4);
  // Alpha decae en el borde para que se vea "soft", no como bola sólida.
  float alpha = 0.85 + fresnel * 0.15;
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
      // Subido de 0.18-0.30 a 0.35-0.55 para que el movimiento sea
      // claramente visible (la sutilidad anterior parecía estatico).
      idleAmpClock.current += delta;
      const fake = 0.45 + 0.18 * Math.sin(idleAmpClock.current * 1.6);
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
      // Más rango de escala (1.0 → 1.15) para que el "latido" del orb se
      // perciba sin necesidad de mirar fijo.
      const scale = 1.0 + dampedAmp.current * 0.15;
      meshRef.current.scale.setScalar(scale);
    }
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1, 6]} />
      <shaderMaterial
        uniforms={uniformsRef.current}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
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
        // iOS guards: limita devicePixelRatio (Retina mata fps en orb
        // shader grande) y pide bajo consumo de GPU.
        dpr={[1, 1.5]}
        gl={{ antialias: false, alpha: true, powerPreference: "low-power" }}
        camera={{ position: [0, 0, 2.6], fov: 55 }}
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
