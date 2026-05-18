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
    .replace(/\s+/g, " ")
    .trim();
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
    const searchableCols = headers.filter((h) =>
      ["nombre", "concentracion", "tipo", "sku", "product", "strength"].includes(norm(h))
    );
    // Identify the main display-name column (prefer "Nombre", then "Product")
    const nameCol =
      headers.find((h) => norm(h) === "nombre") ??
      headers.find((h) => norm(h) === "product") ??
      headers[0];

    console.log(
      `[price] priceCol="${priceColExact}" nameCol="${nameCol}" ` +
        `searchableCols=${JSON.stringify(searchableCols)}`
    );

    const isPriceCol = (h: string) => norm(h).includes("precio");

    // Split into tokens, stem each (handles ES↔EN: "retatrutide" ↔ "retatrutida").
    // Match if every stemmed token appears in the stemmed haystack.
    const tokens = norm(input.product_name).split(/\s+/).filter(Boolean).map(stem);

    const matches = rows
      .filter((r) => {
        const haystack = stemPhrase(norm(searchableCols.map((c) => r[c] ?? "").join(" ")));
        return tokens.every((t) => haystack.includes(t));
      })
      .map((r) => ({
        producto: [r[nameCol], r[headers.find((h) => norm(h) === "concentracion") ?? ""]]
          .filter(Boolean)
          .join(" "),
        precio_mxn_con_iva: r[priceColExact],
        otros_datos: Object.fromEntries(
          Object.entries(r).filter(
            ([k, v]) =>
              k !== priceColExact &&
              !isPriceCol(k) &&
              v &&
              v.length > 0
          )
        ),
      }))
      .slice(0, 5);

    console.log(`[price] matched ${matches.length} results for "${input.product_name}"`);
    return { results: matches, price_column: priceColExact };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[price] error: ${msg}`);
    return { error: msg, results: [] };
  }
}
