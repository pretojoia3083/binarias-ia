import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/logs — ultimos eventos do worker (pra depurar rapido). */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const logs = await getDb()
      .collection("logs")
      .find({})
      .sort({ ts: -1 })
      .limit(80)
      .toArray();

    return {
      logs: logs.map((l: any) => ({
        id: String(l._id),
        ts: l.ts,
        nivel: l.nivel,
        origem: l.origem,
        msg: l.msg,
      })),
    };
  });
}