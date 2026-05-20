import { getSession } from "@/lib/session";
import { executeListPeptidesTool } from "@/lib/peptide-tool";

// Browser-to-server bridge for the Realtime voice agent's list_peptides tool.
// No input required. Returns the catalog (names + short tags).
export async function POST() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const result = await executeListPeptidesTool();
  return Response.json(result);
}
