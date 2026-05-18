import { getSession } from "@/lib/session";
import { executeMemoryTool } from "@/lib/memory-tool";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const args = (await req.json()) as { query?: string; limit?: number };
  const result = await executeMemoryTool(
    { query: args.query ?? "", limit: args.limit },
    session.id
  );
  return Response.json(result);
}
