import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import { rotaProtegida } from "@/lib/auth";
import { parseEntrada } from "@/lib/sinalParser";

export const dynamic = "force-dynamic";

/** GET /api/sinais — listas salvas */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const listas = await getDb()
      .collection("listas")
      .find({})
      .sort({ criado_at: -1 })
      .limit(15)
      .toArray();

    return {
      listas: listas.map((l: any) => ({
        id: String(l._id),
        nome: l.nome,
        criado_em: l.criado_em,
        status: l.status,
        total: (l.sinais || []).length,
        executados: (l.sinais || []).filter((s: any) => s.status === "executado").length,
        aguardando: (l.sinais || []).filter((s: any) => s.status === "aguardando").length,
        sinais: (l.sinais || []).slice(0, 50),
      })),
    };
  });
}

/** POST /api/sinais — cria lista. { nome, texto } */
export async function POST(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const { nome, texto } = await req.json().catch(() => ({}));
    const { sinais, ignoradas, erro } = parseEntrada(String(texto || ""));

    if (erro) return NextResponse.json({ erro }, { status: 400 });

    const doc = {
      nome: String(nome?.trim() || `Lista ${new Date().toLocaleString("pt-BR")}`),
      criado_em: new Date(),
      status: "ativa",
      sinais,
    };
    const r = await getDb().collection("listas").insertOne(doc);
    return { ok: true, id: String(r.insertedId), lidos: sinais.length, ignoradas };
  });
}

/** DELETE /api/sinais — { id } */
export async function DELETE(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const { id } = await req.json().catch(() => ({}));
    if (!id) return NextResponse.json({ erro: "Informe o id" }, { status: 400 });
    await getDb().collection("listas").deleteOne({ _id: new ObjectId(String(id)) });
    return { ok: true };
  });
}