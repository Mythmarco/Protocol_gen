import OpenAI from "openai";
import { getSession } from "@/lib/session";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";
import { OPENAI_RESPONSES_TOOLS } from "@/lib/openai-tools";
import { executePeptideTool, executeListPeptidesTool } from "@/lib/peptide-tool";
import { executePriceTool } from "@/lib/price-tool";
import { executeMemoryTool } from "@/lib/memory-tool";
import { patientHash } from "@/lib/safe-log";
import { newRequestId } from "@/lib/observability";
import { PROTOCOL_JSON_MARKER, type ProtocoloData } from "@/lib/protocol-types";

// Text mode using OpenAI Responses API + GPT-5.5 + Structured Outputs.
//
// Flow:
//  - Stream text chunks live to the client as they arrive
//  - When the model calls a lookup tool (peptide/price/memory) → execute,
//    feed result back, loop
//  - When the model calls finalize_protocol(protocol_data) → emit the
//    structured JSON to the client (with PROTOCOL_JSON_MARKER for ChatPage
//    to parse) and end the conversation
//
// Why this pattern: tool args go through Structured Outputs, so the
// finalize_protocol JSON is GUARANTEED structurally valid (no markdown
// wrapping, no truncation, no missing fields).

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.5";

type ResponseInput = OpenAI.Responses.ResponseInput;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return new Response("OPENAI_API_KEY missing", { status: 500 });
  }

  // Request-id corto para correlacionar logs con el mensaje de error que
  // el doctor ve en pantalla. Sin esto, "me salió error" no era diagnosticable.
  // Workflow item 8.
  const reqId = newRequestId();

  const body = (await req.json()) as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    currentDraft?: ProtocoloData | null;
  };

  // Prompt caching: instructions DEBE ser idéntico request-a-request para
  // que OpenAI cachee el prefijo (~6k tokens, 50% descuento). Antes hacíamos
  // .replace() con email+fecha → cada request tenía un instructions distinto
  // → cache miss permanente. Ahora pasamos el contexto dinámico (fecha,
  // email del doctor) como mensaje al inicio del input; instructions queda
  // constante y se cachea bien. Los valores reales se inyectan también
  // server-side via metadata-enricher post-finalize, así que el modelo no
  // necesita ser exacto con ellos.
  const todayIso = new Date().toISOString().slice(0, 10);
  const contextMessage = {
    role: "user" as const,
    content:
      `### CONTEXTO_RUNTIME (lee y aplica, no respondas a este mensaje)\n` +
      `Fecha de hoy: ${todayIso}\n` +
      `Doctor (creado_por): ${session.email}\n` +
      `Usa estos valores para los campos correspondientes del ProtocoloData.`,
  };

  // Build input from the chat history. Responses API uses {role, content}.
  // If the UI is showing a generated draft, attach it to the LAST user turn
  // as a CURRENT_DRAFT block — the system prompt's "Modo edición" section
  // tells the model to treat it as ground truth and only call tools for
  // NEW data, instead of re-running the whole pipeline.
  const historyInput: ResponseInput = body.messages.map((m, i) => {
    const isLastUser =
      i === body.messages.length - 1 && m.role === "user" && body.currentDraft;
    if (isLastUser) {
      // Si el draft viene del historial, agregamos un warning explícito
      // para que el modelo SEPA que tiene que re-validar precios contra
      // get_product_price. Sin esto el system-prompt decía "reusa TODO
      // incluyendo precios" y los protocolos viejos se re-cotizaban con
      // precios stale — paciente pagaba lo que decía el PDF (mismatch
      // real con catálogo actualizado). Workflow lo flagged como must-fix.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (body.currentDraft as any)?._meta;
      const fromHistory = meta?.loaded_from_history === true;
      const histWarning = fromHistory
        ? `\n\n### ⚠️ ESTE DRAFT VIENE DEL HISTORIAL (precios potencialmente stale)\n` +
          `Antes de finalizar, RE-VALIDA cada precio con get_product_price para cada producto en cotizacion.productos. ` +
          `NO reuses los precio_unitario del draft sin verificar. Si un precio cambió, actualízalo. ` +
          `Si un producto ya no está en el catálogo, sigue las reglas 3/4/5 de PRECIOS — REGLAS DURAS.\n`
        : "";
      return {
        role: m.role,
        content:
          `### CURRENT_DRAFT\n\`\`\`json\n${JSON.stringify(body.currentDraft)}\n\`\`\`\n` +
          histWarning +
          `\n### MENSAJE DEL MÉDICO\n${m.content}`,
      };
    }
    return { role: m.role, content: m.content };
  });
  const input: ResponseInput = [contextMessage, ...historyInput];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Agentic loop: up to 6 turns of tool execution
        for (let turn = 0; turn < 6; turn++) {
          const resp = await client.responses.create({
            model: TEXT_MODEL,
            instructions: SYSTEM_PROMPT, // constante → OpenAI prompt caching
            input,
            tools: OPENAI_RESPONSES_TOOLS,
            tool_choice: "auto",
            reasoning: { effort: "low" },
            text: { verbosity: "low" },
            stream: true,
          });

          const turnToolCalls: Array<{
            call_id: string;
            name: string;
            arguments: string;
          }> = [];
          let assistantTextBuffer = "";
          let finalizeProtocolArgs: string | null = null;

          for await (const event of resp) {
            const type = event.type as string;

            // Streaming text delta → forward to client
            if (type === "response.output_text.delta") {
              const delta = (event as { delta?: string }).delta ?? "";
              if (delta) {
                assistantTextBuffer += delta;
                controller.enqueue(encoder.encode(delta));
              }
              continue;
            }

            // Tool call finished arriving → execute (or capture)
            if (type === "response.output_item.done") {
              const item = (event as { item?: { type?: string } }).item;
              if (item?.type === "function_call") {
                const fnCall = item as {
                  call_id: string;
                  name: string;
                  arguments: string;
                };
                turnToolCalls.push({
                  call_id: fnCall.call_id,
                  name: fnCall.name,
                  arguments: fnCall.arguments ?? "{}",
                });

                if (fnCall.name === "finalize_protocol") {
                  finalizeProtocolArgs = fnCall.arguments ?? "{}";
                }
              }
              continue;
            }

            if (type === "response.error" || type === "error") {
              const err = (event as { error?: unknown }).error;
              console.error("[chat] response error:", err);
            }
          }

          // Persist this turn's outputs back into context
          for (const tc of turnToolCalls) {
            input.push({
              type: "function_call",
              call_id: tc.call_id,
              name: tc.name,
              arguments: tc.arguments,
            } as OpenAI.Responses.ResponseInputItem);
          }

          // If finalize was called → emit structured JSON + stop
          if (finalizeProtocolArgs) {
            try {
              const protocolData = JSON.parse(finalizeProtocolArgs) as ProtocoloData;
              // Inject server-side fields the model shouldn't worry about
              protocolData.metadata.creado_por = session.email;
              controller.enqueue(
                encoder.encode(
                  `\n\n${PROTOCOL_JSON_MARKER}\n${JSON.stringify(protocolData)}\n${PROTOCOL_JSON_MARKER}`
                )
              );
              console.log(`[chat] finalize_protocol OK ${patientHash(protocolData.paciente?.nombre)}`);
            } catch (err) {
              console.error("[chat] finalize_protocol args parse failed:", err);
            }
            // Acknowledge the tool call so the model context is consistent (not strictly
            // needed since we're stopping, but harmless if we ever continue)
            input.push({
              type: "function_call_output",
              call_id: turnToolCalls.find((c) => c.name === "finalize_protocol")!.call_id,
              output: JSON.stringify({ ok: true }),
            } as OpenAI.Responses.ResponseInputItem);
            break;
          }

          // No tools called and no finalize → conversation is done (model is waiting)
          const lookupCalls = turnToolCalls.filter((tc) => tc.name !== "finalize_protocol");
          if (lookupCalls.length === 0) break;

          // Execute each lookup tool, push results
          for (const tc of lookupCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
            } catch (err) {
              console.error(`[chat] tool ${tc.name} bad args:`, tc.arguments, err);
            }

            let result: unknown;
            if (tc.name === "get_peptide_info") {
              result = await executePeptideTool(parsedArgs as { name: string });
            } else if (tc.name === "list_peptides") {
              result = await executeListPeptidesTool();
            } else if (tc.name === "get_product_price") {
              result = await executePriceTool(parsedArgs as { product_name: string });
            } else if (tc.name === "search_past_protocols") {
              result = await executeMemoryTool(
                parsedArgs as { query: string; limit?: number },
                session.id
              );
            } else {
              result = { error: `unknown tool: ${tc.name}` };
            }

            input.push({
              type: "function_call_output",
              call_id: tc.call_id,
              output: JSON.stringify(result),
            } as OpenAI.Responses.ResponseInputItem);
          }

          // Suppress unused warning when there's no streamed text yet
          void assistantTextBuffer;
        }
      } catch (err) {
        console.error(`[chat] reqId=${reqId} stream error:`, err);
        controller.enqueue(
          encoder.encode(
            `\n\n[Error #${reqId} generando respuesta. Intenta de nuevo o repórtalo con ese código.]`
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    },
  });
}
