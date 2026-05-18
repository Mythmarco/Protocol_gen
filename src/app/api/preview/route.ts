import { getSession } from "@/lib/session";
import { buildProtocolHTML } from "@/lib/protocol-template";
import type { ProtocoloData } from "@/lib/protocol-types";

// Returns the same HTML that will be turned into the PDF, so the client can
// show it inside an iframe before the doctor commits to "Guardar PDF".
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { protocolData } = (await req.json()) as { protocolData: ProtocoloData };
  const html = buildProtocolHTML(protocolData, {
    doctor: { name: session.name ?? "", email: session.email },
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
