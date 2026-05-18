// JSON Schema for ProtocoloData, designed for OpenAI Structured Outputs (strict mode).
//
// Strict-mode constraints we comply with:
//   1. additionalProperties: false at every object level
//   2. required: includes EVERY property (no optional fields — use defaults)
//   3. No anyOf/oneOf with primitive mixed types (we split envio into tipo+monto)
//   4. No dynamic-key objects (calendario is an ARRAY of {peptido_label, dias})
//   5. No min/max/minItems constraints (often rejected in strict mode)
//
// Mirrors the TypeScript interface in protocol-types.ts. Keep them in sync.

export const PROTOCOL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["paciente", "protocolo", "cotizacion", "metadata"],
  properties: {
    paciente: {
      type: "object",
      additionalProperties: false,
      required: ["nombre", "peso", "estatura", "edad", "objetivo"],
      properties: {
        nombre: { type: "string" },
        peso: { type: "string", description: "p.ej. '87 kg'" },
        estatura: { type: "string", description: "p.ej. '1.76 m (176 cm)'" },
        edad: { type: "string", description: "p.ej. '37 años'" },
        objetivo: { type: "string" },
      },
    },
    protocolo: {
      type: "object",
      additionalProperties: false,
      required: [
        "titulo",
        "duracion_meses",
        "mes_actual",
        "peptidos",
        "calendario",
        "nota_calendario",
        "indicaciones_generales",
        "explicacion_stack",
      ],
      properties: {
        titulo: { type: "string" },
        duracion_meses: { type: "integer" },
        mes_actual: { type: "integer" },
        peptidos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "nombre",
              "presentacion",
              "dosis",
              "unidades",
              "frecuencia",
              "ciclo",
              "reconstitucion",
              "via",
            ],
            properties: {
              nombre: { type: "string" },
              presentacion: { type: "string", description: "p.ej. '30 mg'" },
              dosis: { type: "string", description: "p.ej. '8 mg por aplicación'" },
              unidades: { type: "string", description: "p.ej. '50 u (reconstituido con 2 mL)'" },
              frecuencia: { type: "string", description: "p.ej. 'Viernes' o 'Lun-Vie'" },
              ciclo: { type: "string" },
              reconstitucion: { type: "string", description: "p.ej. '2 mL agua bacteriostática'" },
              via: { type: "string", enum: ["subcutánea", "intramuscular", "oral"] },
            },
          },
        },
        // Array (NOT object-with-dynamic-keys) — strict mode requires fixed shapes.
        calendario: {
          type: "array",
          description:
            "Una entrada por péptido. Cada entrada: etiqueta del péptido (nombre + presentación) + dosis por día de la semana ('—' si no aplica).",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "peptido_label",
              "Lunes",
              "Martes",
              "Miercoles",
              "Jueves",
              "Viernes",
              "Sabado",
              "Domingo",
            ],
            properties: {
              peptido_label: {
                type: "string",
                description: "p.ej. 'Retatrutide 30 mg'",
              },
              Lunes: { type: "string", description: "dosis o '—'" },
              Martes: { type: "string", description: "dosis o '—'" },
              Miercoles: { type: "string", description: "dosis o '—'" },
              Jueves: { type: "string", description: "dosis o '—'" },
              Viernes: { type: "string", description: "dosis o '—'" },
              Sabado: { type: "string", description: "dosis o '—'" },
              Domingo: { type: "string", description: "dosis o '—'" },
            },
          },
        },
        nota_calendario: { type: "string" },
        indicaciones_generales: {
          type: "array",
          items: { type: "string" },
        },
        explicacion_stack: {
          type: "array",
          description:
            "1-2 párrafos sobre la SINERGIA del stack, NO descripciones individuales.",
          items: { type: "string" },
        },
      },
    },
    cotizacion: {
      type: "object",
      additionalProperties: false,
      required: [
        "descripcion",
        "moneda",
        "productos",
        "descuento",
        "envio_tipo",
        "envio_monto",
        "total",
        "nota",
      ],
      properties: {
        descripcion: { type: "string" },
        moneda: { type: "string", enum: ["MXN", "USD"] },
        productos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["nombre", "qty", "precio_unitario"],
            properties: {
              nombre: { type: "string" },
              qty: { type: "integer" },
              precio_unitario: { type: "number" },
            },
          },
        },
        descuento: { type: "number" },
        envio_tipo: {
          type: "string",
          enum: ["gratis", "costo", "no_aplica"],
          description: "gratis = cortesía. costo = cobrar envío. no_aplica = no se muestra en PDF.",
        },
        envio_monto: {
          type: "number",
          description: "Costo del envío en la moneda elegida. 0 si tipo != 'costo'.",
        },
        total: {
          type: "number",
          description: "sum(qty*precio_unitario) - descuento + envio_monto (si tipo='costo')",
        },
        nota: { type: "string" },
      },
    },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: [
        "version",
        "fecha",
        "fecha_inicio",
        "fecha_revision",
        "creado_por",
        "idioma",
      ],
      properties: {
        version: { type: "string" },
        fecha: { type: "string", description: "YYYY-MM-DD" },
        fecha_inicio: { type: "string" },
        fecha_revision: { type: "string" },
        creado_por: { type: "string", description: "Email del médico" },
        idioma: { type: "string", enum: ["es", "en"] },
      },
    },
  },
} as const;
