export interface Peptido {
  nombre: string;
  presentacion: string;
  dosis: string;
  unidades: string;
  frecuencia: string;
  ciclo: string;
  reconstitucion: string;
  via: "subcutánea" | "intramuscular" | "oral";
}

// One entry per peptide. ASCII day names (Miercoles/Sabado) to keep the JSON
// schema strict-mode-compatible (no accented identifiers).
export interface CalendarioEntrada {
  peptido_label: string;
  Lunes: string;
  Martes: string;
  Miercoles: string;
  Jueves: string;
  Viernes: string;
  Sabado: string;
  Domingo: string;
}

export interface ProductoCotizacion {
  nombre: string;
  qty: number;
  precio_unitario: number;
}

export interface ProtocoloData {
  paciente: {
    nombre: string;
    peso: string;
    estatura: string;
    edad: string;
    objetivo: string;
  };
  protocolo: {
    titulo: string;
    duracion_meses: number;
    mes_actual: number;
    peptidos: Peptido[];
    calendario: CalendarioEntrada[];
    nota_calendario: string;
    indicaciones_generales: string[];
    explicacion_stack: string[];
  };
  cotizacion: {
    descripcion: string;
    moneda: "MXN" | "USD";
    productos: ProductoCotizacion[];
    descuento: number;
    envio_tipo: "gratis" | "costo" | "no_aplica";
    envio_monto: number;
    total: number;
    nota: string;
    // Filled server-side from a Supabase sequence right before PDF generation.
    folio?: string;
    // true → precios YA están en cotizacion.moneda (doctor los dio explícitos
    // ej. "$382 USD"). Server NO los convierte. Default false: precios en
    // MXN del catálogo, server convierte a USD si aplica. Optional para
    // backward-compat con protocolos viejos del historial.
    skip_fx_conversion?: boolean;
  };
  metadata: {
    version: string;
    fecha: string;
    fecha_inicio: string;
    fecha_revision: string;
    creado_por: string;
    idioma: "es" | "en";
  };
}

// Marker still kept for legacy text-mode parsing (the chat route emits the
// final protocol delimited by this for the client to extract).
export const PROTOCOL_JSON_MARKER = "%%%PROTOCOL_JSON%%%";
