import { NextRequest } from "next/server";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/velas?ativo=EURUSD-OTC&tf=M1&qtd=60
 * Proxy para o worker — so ele tem a conexao com a corretora.
 * O painel usa isso para desenhar o grafico.
 */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const workerUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
    if (!workerUrl) return Response.json({ erro: "sem_worker_url", velas: [] }, { status: 200 });

    const q = req.nextUrl.searchParams;
    const url =
      `${workerUrl}/velas?ativo=${encodeURIComponent(q.get("ativo") || "")}` +
      `&tf=${encodeURIComponent(q.get("tf") || "M1")}` +
      `&qtd=${encodeURIComponent(q.get("qtd") || "60")}`;

    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return Response.json({ erro: `worker ${r.status}`, velas: [] }, { status: 200 });
      return Response.json(await r.json());
    } catch (e: any) {
      return Response.json({ erro: String(e?.message || e), velas: [] }, { status: 200 });
    }
  });
}