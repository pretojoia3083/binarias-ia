import { NextRequest } from "next/server";
import { rotaProtegida } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { registrarSugestaoChat } from "@/lib/sugestoes";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // a IA pode demorar

/**
 * POST /api/chat — conversa com a IA.
 *
 * O worker tem a conexao com a corretora, entao quem monta o contexto (velas,
 * noticias, posicao aberta, historico) e ele. O painel so repassa as mensagens
 * e devolve a resposta.
 *
 * Se WORKER_URL nao estiver setado, respondemos com um aviso claro em vez de
 * dar erro 500.
 */
export async function POST(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const { mensagens, ativo, minutos } = await req.json().catch(() => ({}));

    if (!Array.isArray(mensagens) || !mensagens.length) {
      return Response.json({ erro: "Envie ao menos uma mensagem." }, { status: 400 });
    }

    const workerUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
    if (!workerUrl) {
      return Response.json({
        resposta:
          "O painel ainda nao sabe onde esta o worker. Defina WORKER_URL nas variaveis da Vercel " +
          "(ex: https://seu-worker.up.railway.app).",
        erro: "sem_worker_url",
      }, { status: 200 });
    }

    try {
      const r = await fetch(`${workerUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensagens, ativo, minutos }),
        signal: AbortSignal.timeout(70_000),
        cache: "no-store",
      });

      if (!r.ok) {
        return Response.json({ resposta: `Worker respondeu ${r.status}.`, erro: "worker_http" }, { status: 200 });
      }

      const dados = await r.json();

      // se a IA props uma entrada no chat, grava como sugestao aprovavel
      if (dados.sugestao && !dados.sugestao_criada) {
        try {
          dados.sugestao_criada = await registrarSugestaoChat(
            getDb(),
            dados.sugestao.ativo,
            dados.sugestao.direcao,
            dados.sugestao.confianca,
            dados.sugestao.justificativa,
          );
        } catch (e: any) {
          dados.erro_sugestao = e?.message;
        }
      }

      return Response.json(dados);
    } catch (e: any) {
      return Response.json({
        resposta:
          "Nao consegui falar com o worker. Ele esta rodando? Confira o link /health: " +
          `${workerUrl}/health`,
        erro: String(e?.message || e),
      }, { status: 200 });
    }
  });
}