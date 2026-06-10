import { createAdminClient } from "@/utils/supabase/admin";

// Settings per-doctor (tabla protocol_gen_settings en Supabase). Por
// ahora solo manejamos fx_mxn_per_usd, pero la tabla queda abierta para
// futuras prefs (idioma default del PDF, dosis estándar, etc.) sin tocar
// la tabla User compartida con Stacklabs/otras apps.
//
// Resolución del FX en cascada:
//   1. Valor del doctor en protocol_gen_settings (override por usuario)
//   2. Env PEPTIDES_MXN_PER_USD (default global, configurable en Vercel)
//   3. Hardcoded fallback 18.5 (para que la app NUNCA quede sin FX)

export interface FxRate {
  rate: number;
  source: "user" | "env" | "default";
}

const DEFAULT_FX = 18.5;

export async function getDoctorFxRate(userId: string): Promise<FxRate> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("protocol_gen_settings")
      .select("fx_mxn_per_usd")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      // Tabla no existe / RLS / cualquier otro error: caemos a env.
      // NO lanzamos — el FX es un valor de presentación, no debe romper
      // el guardado del PDF si el settings store está caído.
      console.warn(`[settings] getDoctorFxRate error, falling back to env:`, error.message);
    } else if (data?.fx_mxn_per_usd != null) {
      const rate = Number(data.fx_mxn_per_usd);
      if (Number.isFinite(rate) && rate > 0) {
        return { rate, source: "user" };
      }
    }
  } catch (err) {
    console.warn(`[settings] getDoctorFxRate threw, falling back to env:`, err);
  }

  const envRate = Number(process.env.PEPTIDES_MXN_PER_USD || "");
  if (Number.isFinite(envRate) && envRate > 0) {
    return { rate: envRate, source: "env" };
  }
  return { rate: DEFAULT_FX, source: "default" };
}

export async function setDoctorFxRate(
  userId: string,
  rate: number
): Promise<{ ok: true; rate: number } | { ok: false; error: string }> {
  // Validación de rango: tipo de cambio MXN/USD razonable está entre 10
  // y 40. Fuera de eso casi seguro es typo del doctor o input malicioso.
  if (!Number.isFinite(rate) || rate < 10 || rate > 40) {
    return { ok: false, error: "Tipo de cambio debe estar entre 10 y 40 MXN/USD" };
  }
  // Redondeamos a 2 decimales para consistencia con cómo se muestra.
  const rounded = Math.round(rate * 100) / 100;

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("protocol_gen_settings")
      .upsert(
        {
          user_id: userId,
          fx_mxn_per_usd: rounded,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    if (error) {
      console.error(`[settings] setDoctorFxRate error:`, error);
      return { ok: false, error: error.message };
    }
    return { ok: true, rate: rounded };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[settings] setDoctorFxRate threw:`, msg);
    return { ok: false, error: msg };
  }
}
