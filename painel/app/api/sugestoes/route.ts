import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/sugestoes — lista as sugestoes da IA, mais recentes primeiro. */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const db = getDb();
    const itens = await db
      .collection("sugestoes")
      .find({})
      .sort({ created_at: -1 })
      .limit(40)
      .toArray();

    // remove campos internos e converte _id/ObjectId para string
    return {
      sugestoes: itens.map((s: any) => ({
        id: String(s._id),
        criado_em: s.created_at,
        ativo: s.ativo,
        direcao: s.direcao,
        confianca: s.confianca,
        analise: s.analise,
        noticias: s.noticias || "",
        expiracao: s.expiracao,
        valor: s.valor,
        timeframes: s.timeframes,
        status: s.status,
        origem_extra: s.origem_extra || null,
        order_id: s.order_id || null,
      })),
      pendentes: itens.filter((s: any) => s.status === "pendente").length,
    };
  });
}

/** POST /api/sugestoes — aprova ou recusa. { id, acao: 'aprovar' | 'recusar' } */
export async function POST(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const { id, acao } = await req.json();
    if (!id || !["aprovar", "recusar"].includes(acao)) {
      return NextResponse.json({ erro: "Informe id e acao (aprovar|recusar)" }, { status: 400 });
    }

    const db = getDb();
    const novoStatus = acao === "aprovar" ? "aprovada" : "recusada";

    // so muda se ainda estiver pendente — evita clique duplo
    const r = await db.collection("sugestoes").updateOne(
      { _id: new (await import("mongodb")).ObjectId(String(id)), status: "pendente" },
      { $set: { status: novoStatus, decidida_em: new Date() } }
    );

    if (r.modifiedCount === 0) {
      return NextResponse.json({ erro: "Sugestao ja foi decidida ou nao existe" }, { status: 409 });
    }

    return { ok: true, id, status: novoStatus };
  });
}