import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/trades — historico de operacoes + estatisticas. */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const db = getDb();

    const trades = await db
      .collection("trades")
      .find({})
      .sort({ created_at: -1 })
      .limit(60)
      .toArray();

    const res = await db
      .collection("trades")
      .aggregate([
        { $match: { status: { $in: ["ganho", "perdido"] } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            ganhos: { $sum: { $cond: [{ $eq: ["$status", "ganho"] }, 1, 0] } },
            lucro_total: { $sum: "$lucro" },
          },
        },
      ])
      .toArray();

    const r = res[0] || { total: 0, ganhos: 0, lucro_total: 0 };
    const total = r.total || 0;
    const ganhos = r.ganhos || 0;

    return {
      trades: trades.map((t: any) => ({
        id: String(t._id),
        criado_em: t.created_at,
        finalizado_em: t.finalizado_em || null,
        origem: t.origem,
        ativo: t.ativo,
        direcao: t.direcao,
        valor: t.valor,
        lucro: t.lucro,
        ganho_pct: t.ganho_pct ?? null,
        expiracao: t.expiracao,
        status: t.status,
        order_id: t.order_id || null,
        erro: t.motivo_erro || null,
        martingale_passo: t.martingale_passo || 0,
      })),
      stats: {
        total,
        ganhos,
        perdas: total - ganhos,
        assertividade: total ? Math.round((ganhos / total) * 1000) / 10 : 0,
        lucro_total: Math.round((r.lucro_total || 0) * 100) / 100,
      },
    };
  });
}