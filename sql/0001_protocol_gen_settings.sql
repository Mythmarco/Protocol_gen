-- Migration: protocol_gen_settings
-- Tabla de preferencias per-doctor para protocol-gen. NO toca la tabla
-- User compartida con Stacklabs/CodexMed — mantiene aisladas las
-- preferencias de esta app.
--
-- Hoy solo guarda fx_mxn_per_usd (tipo de cambio para cotizaciones en
-- USD). Diseñada para crecer con más columnas (idioma_default,
-- envio_default, etc.) sin migraciones futuras complicadas.
--
-- Corre esto UNA vez en Supabase SQL Editor:
--   https://supabase.com/dashboard/project/<tu-proyecto>/sql/new

CREATE TABLE IF NOT EXISTS protocol_gen_settings (
  user_id text PRIMARY KEY,
  fx_mxn_per_usd numeric(8, 4),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index implícito por PRIMARY KEY (user_id) — el lookup es siempre por
-- user_id. No necesitamos más índices por ahora.

-- RLS: la admin client del servidor usa service role (bypassa RLS),
-- así que técnicamente no necesitamos políticas. Las habilitamos
-- igual + niegamos todo para que NUNCA un cliente con anon key pueda
-- leer/escribir directo desde el browser. Defense in depth.
ALTER TABLE protocol_gen_settings ENABLE ROW LEVEL SECURITY;

-- Sin policies = sin acceso para anon role. Solo service role (que
-- usa el server) tiene acceso.

-- Trigger para mantener updated_at correcto si el cliente olvida pasarlo.
CREATE OR REPLACE FUNCTION protocol_gen_settings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protocol_gen_settings_touch ON protocol_gen_settings;
CREATE TRIGGER trg_protocol_gen_settings_touch
  BEFORE UPDATE ON protocol_gen_settings
  FOR EACH ROW
  EXECUTE FUNCTION protocol_gen_settings_touch_updated_at();
