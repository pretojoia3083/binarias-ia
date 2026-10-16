import { NextRequest } from "next/server";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/precos?ativos=EURUSD-OTC,GBPUSD-OTC&qtd=20 — proxy pro worker */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const workerUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
    if (!workerUrl) return Response.json({ erro: "sem_worker_url", precos: [] }, { status: 200 });

    const q = req.nextUrl.searchParams;
    const url =
      `${workerUrl}/precos?ativos=${encodeURIComponent(q.get("ativos") || "")}` +
      `&qtd=${encodeURIComponent(q.get("qtd") || "20")}`;

    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
      if (!r.ok) return Response.json({ erro: `worker ${r.status}`, precos: [] }, { status: 200 });
      return Response.json(await r.json());
    } catch (e: any) {
      return Response.json({ erro: String(e?.message || e), precos: [] }, { status: 200 });
    }
  });
}