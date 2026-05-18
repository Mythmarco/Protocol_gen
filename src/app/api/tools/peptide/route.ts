import { getSession } from "@/lib/session";
import { executePeptideTool } from "@/lib/peptide-tool";

// Browser-to-server bridge for the Realtime agent's get_peptide_info tool.
// The Realtime model emits a function call in the browser; the browser POSTs
// here with the args; we run the same lookup the text agent uses.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const args = (await req.json()) as { name?: string };
  const result = await executePeptideTool({ name: args.name ?? "" });
  return Response.json(result);
}
