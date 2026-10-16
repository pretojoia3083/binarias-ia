import { NextRequest, NextResponse } from "next/server";
import { getDb, estadoWorker } from "@/lib/mongo";
import { rotaProtegida } from "@/lib/auth";

export const dynamic = "force-dynamic";

const PADRAO = {
  broker: { email: "", password: "", account_type: "PRACTICE" },
  trade: {
    active: "EURUSD-OTC", amount: 10, expiration: 15,
    martingale: false, mart_mult: 2.2, mart_steps: 3,
  },
  ai: {
    enabled: true, model: "gpt-4o-mini",
    timeframes: ["M1", "M5", "M15"], interval_sec: 60, min_confidence: 70,
    usar_noticias: true, noticias_max: 8,
  },
  sinais: { enabled: false, auto_confirmar: false },
};

function merge(destino: any, novo: any) {
  for (const [k, v] of Object.entries(novo || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && destino[k] && typeof destino[k] === "object") {
      merge(destino[k], v);
    } else {
      destino[k] = v;
    }
  }
  return destino;
}

/** GET /api/config — devolve a config; a senha da corretora vem mascarada. */
export async function GET(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const db = getDb();
    const col = db.collection<any>("config"); // _id e a string "global"
    let doc = await col.findOne({ _id: "global" });
    if (!doc) {
      await col.insertOne({ ...PADRAO, _id: "global", updated_at: new Date() });
      doc = { ...PADRAO, _id: "global" };
    }
    const { _id, openai_key, ...cfg } = doc as any;
    const config = merge(JSON.parse(JSON.stringify(PADRAO)), cfg);
    // nunca devolve a senha da corretora nem a chave da OpenAI pro navegador
    const temSenha = Boolean(config.broker?.password);
    config.broker = { ...config.broker, password: "", temSenha };
    return { config, worker: await estadoWorker() };
  });
}

/** POST /api/config — salva (merge na profundidade correta). */
export async function POST(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const corpo = await req.json();
    const db = getDb();
    const col = db.collection<any>("config");
    const atual = (await col.findOne({ _id: "global" })) || { ...PADRAO };

    // se a senha veio vazia, mantem a que ja estava
    if (!corpo?.broker?.password) {
      const senhaAtual = (atual as any).broker?.password;
      if (senhaAtual) corpo.broker = { ...corpo.broker, password: senhaAtual };
    }

    const novo = merge(JSON.parse(JSON.stringify(atual)), corpo);
    novo._id = "global";
    novo.updated_at = new Date();
    await col.replaceOne({ _id: "global" }, novo, { upsert: true });

    const { _id, openai_key, ...resposta } = novo as any;
    resposta.broker = { ...resposta.broker, password: undefined };
    return { ok: true, config: resposta };
  });
}