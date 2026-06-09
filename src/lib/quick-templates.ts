// Plantillas que el doctor puede pegar/inyectar en el modo texto. La
// idea es darle TODOS los campos al modelo en un solo turno para que NO
// tenga que preguntar peptidos/dosis/moneda/envío en round-trips
// separados. Cada round-trip a GPT-5.5 con reasoning medium cuesta
// ~3-8s; pasar de 4-5 turnos a 1 baja el tiempo de generación
// significativamente y reduce la cuenta de tokens.
//
// El modelo entiende el formato libremente — no requiere parser estricto.
// Mientras los campos estén identificables ("Peso:", "Retatrutida 15 mg",
// etc.) la extracción funciona.

/**
 * Plantilla vacía — el doctor la rellena. Inyectada por el botón
 * "Plantilla rápida". Mantén el formato consistente con los EXAMPLES de
 * abajo para que el modelo aprenda el patrón una vez.
 */
export const EMPTY_TEMPLATE = `PACIENTE
  Nombre:
  Peso:
  Estatura:
  Edad:
  Objetivo:

PÉPTIDOS
  1. [Nombre] [presentación mg] — [dosis mg]/aplicación — [frecuencia + día] — [unidades de jeringa]

PROTOCOLO
  Duración:   1 mes
  Mes actual: 1
  Idioma PDF: español
  Moneda:     MXN
  Envío:      gratis

NOTAS: `;

export interface QuickExample {
  /** Texto corto para el chip — lo que se ve en el UI. */
  label: string;
  /** Plantilla completa que se inyecta al textarea cuando el doctor toca el chip. */
  fullText: string;
}

/**
 * Ejemplos pre-llenados. El doctor toca uno y la plantilla completa
 * (con TODOS los campos) entra al textarea. Esto da al modelo todo lo
 * necesario para finalizar el protocolo en 1-2 turnos en vez de 4-5.
 */
export const EXAMPLE_TEMPLATES: QuickExample[] = [
  {
    label: "Diego de la Garza · Retatrutida mes 2",
    fullText: `PACIENTE
  Nombre: Diego de la Garza
  Peso: 87 kg
  Estatura: 1.76 m
  Edad: 37 años
  Objetivo: pérdida de peso visceral

PÉPTIDOS
  1. Retatrutida 15 mg — 8 mg/aplicación — 1× semana viernes — 50 u

PROTOCOLO
  Duración:   3 meses
  Mes actual: 2
  Idioma PDF: español
  Moneda:     MXN
  Envío:      gratis

NOTAS: continuación del mes 1, tolerancia GI buena, mantener dosis.`,
  },
  {
    label: "Ana López · Stack energía+recup mes 1",
    fullText: `PACIENTE
  Nombre: Ana López
  Peso: 68 kg
  Estatura: 1.65 m
  Edad: 42 años
  Objetivo: energía y recuperación

PÉPTIDOS
  1. Ipamorelin 10 mg — 0.3 mg/aplicación — 5× semana lunes a viernes nocturno — 15 u
  2. CJC 1295 NO DAC 10 mg — 0.3 mg/aplicación — 5× semana lunes a viernes nocturno — 15 u
  3. NAD+ 1000 mg — 50 mg/aplicación — 2× semana martes y jueves — 10 u

PROTOCOLO
  Duración:   3 meses
  Mes actual: 1
  Idioma PDF: español
  Moneda:     MXN
  Envío:      gratis

NOTAS: paciente nueva, primer ciclo de péptidos.`,
  },
];
