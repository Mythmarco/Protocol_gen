import type Anthropic from "@anthropic-ai/sdk";
import { getSheetsClient, hasGoogleAuth } from "./google-auth";

// Reads the Peptides4ALL public-price sheet via the Sheets API, using the
// same service account configured for Drive. Does NOT depend on the sheet
// being publicly shared.
const SHEET_ID = "1rl_ik_WsjTt0jP9nkRASGXbs9sV-p1ah3R0RdSNE5KI";
const SHEET_RANGE = "A:Z"; // Reads all columns from the first sheet
const PRICE_COLUMN = "Precio al Público + IVA";

// Accent-insensitive, case-insensitive normalization for column matching.
const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    // ES↔EN transliteration bridges common in peptide/medical names so
    // glutathione↔glutatión, thymalin↔timalina, phenibut↔fenibut all collapse
    // to the same haystack. Both sides go through this same norm, so the
    // mapping target ("t", "f") just needs to be consistent — not "correct".
    .replace(/th/g, "t")
    .replace(/ph/g, "f")
    // Guiones, slashes, paréntesis → espacio. El catálogo escribe "BPC 157"
    // mientras los doctores dictan "BPC-157" — sin esto la query
    // se rompía. También "PT-141" vs "PT 141", "5 AMINO 1 MQ (Oral)" vs
    // "5 AMINO 1 MQ Oral", etc.
    .replace(/[-_/(),]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse precio del sheet ("$6,960" | "1044" | "$ 1,234.50") → number 6960.
// Necesario porque el schema del protocol.cotizacion.productos.precio_unitario
// es type:"number"; antes le pasábamos el string y el modelo tenía que
// quitar el $ y la coma a mano — fallaba intermitentemente (a veces dejaba
// el $ pegado, a veces convertía "1,044" en 1.044, etc.) y los precios
// salían inventados o en cero en el PDF.
function parsePrice(raw: string): number {
  if (!raw) return 0;
  // Quitar $, espacios, comas, y cualquier letra (MXN, USD inline si la hay).
  const cleaned = raw.replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Loose ES↔EN stem: drop trailing vowel on words ≥5 chars so
// "retatrutide" ↔ "retatrutida", "insulin" ↔ "insulina", "tirzepatide" ↔ "tirzepatida".
// Short tokens (numbers, "mg", "ml") pass through untouched.
function stem(token: string): string {
  if (token.length < 5) return token;
  return token.replace(/[aeiou]$/i, "");
}

// Stem every word in a phrase (used to normalize the haystack the same way).
function stemPhrase(phrase: string): string {
  return phrase.split(/\s+/).map(stem).join(" ");
}

interface PriceRow {
  [column: string]: string;
}

let cache: { rows: PriceRow[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export const PRICE_TOOL: Anthropic.Tool = {
  name: "get_product_price",
  description:
    "Devuelve el precio público en MXN CON IVA INCLUIDO de un producto del " +
    "catálogo de Peptides4ALL (campo 'precio_mxn_con_iva' del resultado, " +
    "tomado de la columna 'Precio al Público + IVA' del sheet oficial). " +
    "Usa SIEMPRE 'precio_mxn_con_iva' para la cotización — ese ya incluye IVA. " +
    "Búsqueda case-insensitive parcial sobre el nombre del producto. " +
    "Si devuelve un array vacío, pregúntale al médico el precio.",
  input_schema: {
    type: "object",
    properties: {
      product_name: {
        type: "string",
        description:
          "Nombre del producto a buscar (p.ej. 'Retatrutide 30 mg', 'BPC-157', " +
          "'Agua bacteriostática', 'Jeringa'). Búsqueda parcial.",
      },
    },
    required: ["product_name"],
  },
};

async function loadSheet(): Promise<PriceRow[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    console.log(`[price] using cached sheet (${cache.rows.length} rows)`);
    return cache.rows;
  }

  if (!hasGoogleAuth()) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON no está configurado. Necesario para leer el sheet de precios."
    );
  }

  console.log(`[price] fetching sheet ${SHEET_ID} via Sheets API`);
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const matrix = res.data.values ?? [];
  if (matrix.length < 2) {
    console.warn(`[price] sheet has fewer than 2 rows (${matrix.length})`);
    return [];
  }

  const headers = matrix[0].map((h: unknown) => String(h ?? "").trim());
  console.log(`[price] sheet loaded: ${matrix.length - 1} rows, headers=${JSON.stringify(headers)}`);

  const rows: PriceRow[] = matrix.slice(1).map((cells: unknown[]) => {
    const obj: PriceRow = {};
    headers.forEach((h, i) => {
      obj[h] = String(cells[i] ?? "").trim();
    });
    return obj;
  });

  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

export async function executePriceTool(input: { product_name: string }) {
  console.log(`[price] executePriceTool called with product_name="${input?.product_name}"`);
  if (!input?.product_name) return { error: "missing product_name", results: [] };

  try {
    const rows = await loadSheet();
    if (rows.length === 0) return { results: [], note: "Sheet is empty." };

    const headers = Object.keys(rows[0]);
    const priceColExact = headers.find((h) => norm(h) === norm(PRICE_COLUMN));
    if (!priceColExact) {
      console.error(
        `[price] price column not found. Looking for norm="${norm(PRICE_COLUMN)}". ` +
          `Tried norm-headers: ${headers.map((h) => `"${norm(h)}"`).join(", ")}`
      );
      return {
        error: `Column "${PRICE_COLUMN}" not found. Available columns: ${headers.join(", ")}`,
        results: [],
      };
    }

    // Search across the columns that actually contain the product identity:
    // Nombre + Concentración + Tipo + SKU + Product + Strength (covers EN/ES variants).
    // Nota: "Strength" se normaliza a "strengt" por la regla th→t. Lo
    // incluimos explícitamente para no perder esa columna del sheet.
    const SEARCHABLE_NORM = new Set([
      "nombre",
      "concentracion",
      "tipo",
      "sku",
      "product",
      "strength",
      "strengt", // norm("Strength") por el th→t bridge
    ]);
    const searchableCols = headers.filter((h) => SEARCHABLE_NORM.has(norm(h)));
    // Identify the main display-name column (prefer "Nombre", then "Product")
    const nameCol =
      headers.find((h) => norm(h) === "nombre") ??
      headers.find((h) => norm(h) === "product") ??
      headers[0];

    console.log(
      `[price] priceCol="${priceColExact}" nameCol="${nameCol}" ` +
        `searchableCols=${JSON.stringify(searchableCols)}`
    );

    // Columnas que el modelo realmente necesita ver. otros_datos (todo el
     // resto de columnas del sheet) inflaba el contexto con strings que el
     // modelo nunca usaba para cotizar.
    const concentracionCol = headers.find((h) => norm(h) === "concentracion");
    const skuCol = headers.find((h) => norm(h) === "sku");

    // Split into tokens, stem each (handles ES↔EN: "retatrutide" ↔ "retatrutida").
    // Match if every stemmed token appears in the stemmed haystack.
    const normalizedQuery = norm(input.product_name);
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean).map(stem);
    // ¿La query incluye concentración? Revisamos la FRASE COMPLETA con
    // espacios opcionales entre número y unidad — "30 mg" tokenizado son
    // dos tokens ("30", "mg") y un test por-token no detectaría la unidad.
    // Detecta: "15mg", "15 mg", "500 mcg", "10 ml", "20 IU", etc.
    const hasConcentration = /\d+\s*(mg|ui|iu|mcg|ml)\b/i.test(normalizedQuery);
    // Tokens "base" = sin la concentración (para fallback). Quitamos
    // cualquier token con dígito y cualquier unidad pura.
    const baseTokens = tokens.filter((t) => !/\d/.test(t) && !/^(mg|ui|iu|mcg|ml)$/i.test(t));

    // Word-set match: cada token de la query tiene que aparecer como
    // PALABRA COMPLETA en el haystack, no como substring. Antes era
    // `haystack.includes(t)` que hacía que "50" matcheara "500" (de "TB
    // 500 + BPC 157") — el doctor pedía "BPC-157 50 mg" y le devolvíamos
    // el blend de TB 500 con precio incorrecto.
    const matchTokens = (queryTokens: string[]) =>
      rows.filter((r) => {
        const words = new Set(
          stemPhrase(norm(searchableCols.map((c) => r[c] ?? "").join(" ")))
            .split(/\s+/)
            .filter(Boolean)
        );
        return queryTokens.every((t) => words.has(t));
      });

    let allMatches = matchTokens(tokens);

    // Ranking por especificidad: cuando varios productos matchean los
    // mismos tokens, preferimos el que tenga MENOS palabras extras en su
    // nombre — un match "exacto" es mejor que un match "contenedor". Caso:
    // query "BPC-157 10 mg" matcheaba TANTO "BPC 157 10 MG" (standalone,
    // 4 palabras) COMO "TB 500 + BPC 157 10 MG C/U" (blend, 8 palabras).
    // Sin ranking, .slice(0,1) agarraba el blend porque aparece antes en
    // el sheet. Ranking por número de palabras del Nombre asegura que el
    // standalone gana.
    if (allMatches.length > 1) {
      const nameWordCount = (r: PriceRow) =>
        norm(r[nameCol] ?? "").split(/\s+/).filter(Boolean).length;
      allMatches = [...allMatches].sort(
        (a, b) => nameWordCount(a) - nameWordCount(b)
      );
    }

    // FALLBACK: si la query traía concentración pero NO hubo match (ej.
    // "Tirzepatida 30 mg" cuando el catálogo solo tiene 20/40/60), re-busca
    // con solo los tokens base ("tirzepatid") para mostrar al modelo qué
    // concentraciones SÍ existen. Sin esto, el modelo ve 0 resultados y
    // termina inventando un precio o cotizando 0 — bug que el doctor reportó.
    let usedFallback = false;
    let effectiveMatches = allMatches;
    if (hasConcentration && allMatches.length === 0 && baseTokens.length > 0) {
      effectiveMatches = matchTokens(baseTokens);
      usedFallback = effectiveMatches.length > 0;
    }

    // Cuando hay concentración exacta, devuelve solo 1; cuando hubo
    // fallback o query genérica, devolvemos hasta 8 para que el modelo
    // vea el rango completo y pueda escoger la más cercana o pedir
    // confirmación al doctor.
    const trimmed =
      hasConcentration && !usedFallback
        ? effectiveMatches.slice(0, 1)
        : effectiveMatches.slice(0, 8);

    const matches = trimmed.map((r) => {
      const slim: Record<string, string | number> = {
        producto: [r[nameCol], concentracionCol ? r[concentracionCol] : ""]
          .filter(Boolean)
          .join(" "),
        // Precio YA parseado a número. Antes mandábamos el string
        // crudo del sheet ("$6,960" o "1044") y el modelo tenía que
        // limpiarlo a mano — fallaba intermitentemente y terminaba
        // poniendo precios en 0 o inventados. Ahora es un number listo
        // para meter en cotizacion.productos[].precio_unitario.
        precio_mxn_con_iva: parsePrice(r[priceColExact]),
      };
      if (skuCol && r[skuCol]) slim.sku = r[skuCol];
      if (concentracionCol && r[concentracionCol]) slim.concentracion = r[concentracionCol];
      return slim;
    });

    console.log(
      `[price] matched ${allMatches.length} (returning ${matches.length})` +
        ` for "${input.product_name}"` +
        (hasConcentration ? " [concentration-specific]" : "") +
        (usedFallback ? " [fallback-base-name]" : "")
    );
    return {
      results: matches,
      price_column: priceColExact,
      ...(usedFallback && {
        note:
          "La concentración exacta solicitada NO existe en el catálogo. " +
          "Se devuelven las concentraciones disponibles del mismo producto. " +
          "NO inventes el precio para una concentración inexistente — pídele " +
          "al médico que confirme cuál de las disponibles usar.",
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[price] error: ${msg}`);
    return { error: msg, results: [] };
  }
}
