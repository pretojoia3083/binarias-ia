import { Db } from "mongodb";

/**
 * Grava uma sugestao proposta pela IA durante o chat.
 * Fica como "pendente" — o trader ainda precisa aprovar no painel.
 * Mesma colecao que o fluxo automatico usa, entao o worker executa igual.
 */
export async function registrarSugestaoChat(
  db: Db,
  ativo: string,
  direcao: "CALL" | "PUT",
  confianca: number,
  justificativa: string
) {
  const cfg: any = (await db.collection<any>("config").findOne({ _id: "global" })) || {};
  const trade = cfg.trade || {};
  const ia = cfg.ai || {};

  const doc = {
    created_at: new Date(),
    ativo: String(ativo || "").toUpperCase(),
    direcao,
    confianca: Math.max(0, Math.min(100, Number(confianca) || 0)),
    analise: `[via chat] ${justificativa || ""}`,
    noticias: "",
    expiracao: Number(trade.expiration) || 15,
    valor: Number(trade.amount) || 10,
    timeframes: ia.timeframes || ["M1", "M5", "M15"],
    status: "pendente",
    origem_extra: { tipo: "chat" },
    modelo: ia.model || "gpt-4o-mini",
  };

  const r = await db.collection("sugestoes").insertOne(doc);

  return {
    id: String(r.insertedId),
    ativo: doc.ativo,
    direcao: doc.direcao,
    confianca: doc.confianca,
    expiracao: doc.expiracao,
    valor: doc.valor,
  };
}