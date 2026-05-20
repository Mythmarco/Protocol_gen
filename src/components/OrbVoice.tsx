"use client";

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/refs */
// React 19 lint rules sobre "no mutar después de render" / "no acceder refs
// en render" no aplican aquí: useFrame de R3F corre FUERA del ciclo de
// render de React (es el rAF loop interno de three.js). Mutar uniforms y
// pasar uniformsRef.current al ShaderMaterial es el patrón intencional de
// R3F desde hace 5 años. Disable es justificado y aislado a este archivo.

// Audio-reactive AI orb (R3F + GLSL shader).
//
// Visual = una esfera redonda con NUBE DE COLOR INTERNA. El movimiento NO
// vive en la geometría (vertex displacement) sino en el fragment shader
// (simplex noise 3D animado mezclado con el normal de la esfera). Esto
// mantiene la silueta perfectamente redonda — el doctor reportó "picos"
// y "se corta del borde superior" cuando el displacement era alto.
//
// Patrón inspirado en Apple Intelligence / ChatGPT Voice / ElevenLabs:
// orb sólido afuera, plasma/aurora adentro.
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
   * Tamaño en px del canvas. La esfera ocupa ~70% del canvas (camera FOV
   * 50 + radio 1 + z=3.0 deja ~30% de aire alrededor para que el glow
   * exterior no se corte cuando el orb respira).
   */
  size?: number;
  className?: string;
  /**
   * Estado actual del agente. Solo afecta colores; el patrón interno
   * reacciona a inputLevelRef/outputLevelRef.
   */
  state?: OrbState;
  /** Amplitud del mic 0-1 (poblada por useVoiceLevels). */
  inputLevelRef?: RefObject<number>;
  /** Amplitud del PCM de la IA 0-1. */
  outputLevelRef?: RefObject<number>;
}

// Paleta por estado — RGB 0-1 para GLSL. Tres colores por estado para que
// la nube interna tenga profundidad (en vez de un gradiente plano 2-color).
const COLORS: Record<
  OrbState,
  { a: [number, number, number]; b: [number, number, number]; c: [number, number, number] }
> = {
  // Idle: ámbar cálido + coral + crema. Marca Peptides4ALL en reposo.
  idle:      { a: [0.95, 0.69, 0.34], b: [0.98, 0.52, 0.32], c: [0.99, 0.88, 0.66] },
  // Listening (doctor habla): cyan + azul profundo + blanco. "Recibiendo".
  listening: { a: [0.30, 0.72, 0.96], b: [0.18, 0.40, 0.85], c: [0.85, 0.95, 1.00] },
  // Speaking (IA responde): naranja vibrante + ámbar + crema. Activo.
  speaking:  { a: [0.98, 0.55, 0.22], b: [0.95, 0.30, 0.20], c: [0.99, 0.86, 0.55] },
  // Thinking: violeta + magenta + lavanda. Contemplativo, diferenciado.
  thinking:  { a: [0.52, 0.32, 0.82], b: [0.82, 0.36, 0.78], c: [0.78, 0.72, 0.96] },
};

// Vertex shader: displacement MUY SUAVE — solo lo justo para que la esfera
// "respire" sutilmente al hablar. La silueta sigue siendo casi un círculo
// perfecto. Toda la acción visual vive en el fragment shader.
const vertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vPos;

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
  // Displacement bajísimo (0.015 idle, +0.05 con audio máximo). Suficiente
  // para que la esfera respire al hablar pero NUNCA crea picos visibles
  // en la silueta. El bug "se corta del borde superior" venía de
  // disp=0.18+0.55*uAmp que producía spikes radiales.
  float n = snoise(pos * 1.6 + uTime * 0.45);
  float disp = n * (0.015 + uAmp * 0.05);
  vec3 displaced = pos + normal * disp;
  vPos = pos; // para muestrear noise en el fragment
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

// Fragment shader: aquí vive la "nube de colores" interna. Dos octavas de
// simplex noise 3D animadas mezclan los 3 colores del estado dentro de la
// esfera. Fresnel rim agrega el halo en el borde. La amplitud (uAmp) hace
// que la nube se mueva más rápido cuando el doctor o la IA hablan.
const fragmentShader = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vPos;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uAmp;
uniform float uTime;

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
  // Velocidad del flujo de la nube: base lenta + bump con amplitud.
  float speed = 0.35 + uAmp * 0.9;
  vec3 q = vPos * 1.8 + vec3(0.0, uTime * speed, uTime * speed * 0.55);

  // Dos octavas de simplex 3D mezcladas → patrón orgánico, sin parecer
  // grid. Normalizamos a 0-1.
  float n1 = snoise(q);
  float n2 = snoise(q * 2.3 + vec3(uTime * 0.25));
  float cloud = (n1 * 0.65 + n2 * 0.35) * 0.5 + 0.5;

  // Tercer noise para decidir qué color usar (A, B o C) en cada zona.
  float pick = snoise(q * 1.2 + vec3(uTime * 0.15)) * 0.5 + 0.5;

  // Mezcla 3-color: pick < 0.5 → A↔B; pick ≥ 0.5 → B↔C. Suaviza con cloud.
  vec3 c1 = mix(uColorA, uColorB, smoothstep(0.0, 0.55, pick));
  vec3 c2 = mix(uColorB, uColorC, smoothstep(0.45, 1.0, pick));
  vec3 cloudCol = mix(c1, c2, smoothstep(0.40, 0.60, pick));

  // Brillo interno modulado por la densidad del noise — zonas más densas
  // brillan más, como una nube de plasma.
  cloudCol *= 0.65 + cloud * 0.65;

  // Fresnel: borde más brillante (halo). Curva 2.0 para halo suave, no anillo.
  float ndv = max(dot(vNormal, vViewDir), 0.0);
  float fresnel = pow(1.0 - ndv, 2.0);

  // Mix nube → halo en el borde.
  vec3 rim = mix(uColorC, vec3(1.0), 0.45);
  vec3 col = mix(cloudCol, rim, fresnel * (0.45 + uAmp * 0.35));

  // Alpha: silueta sólida pero borde extremo se funde suavemente con el
  // fondo cream del app — evita la línea hard del mesh.
  float edge = pow(1.0 - ndv, 5.5);
  float alpha = 0.95 - edge * 0.35;
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
      value: new THREE.Color(COLORS.idle.a[0], COLORS.idle.a[1], COLORS.idle.a[2]),
    },
    uColorB: {
      value: new THREE.Color(COLORS.idle.b[0], COLORS.idle.b[1], COLORS.idle.b[2]),
    },
    uColorC: {
      value: new THREE.Color(COLORS.idle.c[0], COLORS.idle.c[1], COLORS.idle.c[2]),
    },
  });
  const dampedAmp = useRef(0);
  const dampedColorA = useRef<[number, number, number]>([...COLORS.idle.a]);
  const dampedColorB = useRef<[number, number, number]>([...COLORS.idle.b]);
  const dampedColorC = useRef<[number, number, number]>([...COLORS.idle.c]);
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
      // Fake amplitude para idle/thinking — la nube interna fluye sin
      // audio. Más bajo que antes (0.35±0.15) porque ahora el movimiento
      // vive en el fragment shader y no necesita amplitud alta para verse.
      idleAmpClock.current += delta;
      const t = idleAmpClock.current;
      const fake = 0.35 + 0.12 * Math.sin(t * 1.8) + 0.05 * Math.sin(t * 4.2);
      targetAmp = Math.max(targetAmp, fake);
    }
    dampedAmp.current += (targetAmp - dampedAmp.current) * 0.15;

    const tgt = COLORS[state];
    lerp3InPlace(dampedColorA.current, tgt.a, 0.06);
    lerp3InPlace(dampedColorB.current, tgt.b, 0.06);
    lerp3InPlace(dampedColorC.current, tgt.c, 0.06);

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
    uniformsRef.current.uColorC.value.setRGB(
      dampedColorC.current[0],
      dampedColorC.current[1],
      dampedColorC.current[2]
    );

    if (meshRef.current) {
      // Scale rango muy contenido (1.0 → 1.06) — el "respirar" debe ser
      // sutil, no agresivo. El audio se siente en la nube interna, no en
      // el tamaño del orb. Rotación super lenta para que el patrón
      // interno se sienta "vivo" sin marear.
      const scale = 1.0 + dampedAmp.current * 0.06;
      meshRef.current.scale.setScalar(scale);
      meshRef.current.rotation.y += delta * 0.08;
      meshRef.current.rotation.x += delta * 0.03;
    }
  });

  return (
    <mesh ref={meshRef}>
      {/* Subdiv 6 = ~640 vértices. Suficiente con displacement bajísimo;
          la silueta se ve perfectamente circular. Subdiv 8 sería waste
          porque el patrón vive en el fragment, no en la geometría. */}
      <icosahedronGeometry args={[1, 6]} />
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
        // dpr 2 en pantallas Retina para silueta crisp. antialias true es
        // CRÍTICO para que la silueta no se vea poligonal.
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        // z=3.0 + fov 50 = ~28% aire alrededor del orb. Suficiente para
        // que el scale 1.06 no recorte el orb contra el borde del canvas
        // (era el bug "se corta del borde superior al respirar").
        camera={{ position: [0, 0, 3.0], fov: 50 }}
        frameloop="always"
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[2, 3, 4]} intensity={0.5} />
        <OrbMesh
          state={state}
          inputLevelRef={inputLevelRef}
          outputLevelRef={outputLevelRef}
        />
      </Canvas>
    </div>
  );
}
