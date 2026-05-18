import { getSession } from "@/lib/session";
import { executePriceTool } from "@/lib/price-tool";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const args = (await req.json()) as { product_name?: string };
  const result = await executePriceTool({ product_name: args.product_name ?? "" });
  return Response.json(result);
}
