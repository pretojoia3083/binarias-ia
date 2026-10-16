import { MongoClient, Db } from "mongodb";

/**
 * Conexao com o MESMO MongoDB do worker.
 * O painel le e escreve; o worker le e escreve. Mongo e o ponto de encontro.
 *
 * No Next.js (dev e Vercel) o modulo e recarregado a cada hot-reload,
 * por isso guardamos o cliente em globalThis para nao abrir varias conexoes.
 */
declare global {
  // eslint-disable-next-line no-var
  var __mongo: { client: MongoClient; db: Db } | undefined;
}

export function getDb(): Db {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI nao configurada na Vercel");

  if (!globalThis.__mongo) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 5,
    });
    globalThis.__mongo = { client, db: client.db(process.env.MONGO_DB || "binarias_ia") };
  }
  return globalThis.__mongo.db;
}

export async function estadoWorker() {
  try {
    const s = await getDb().collection<any>("status").findOne({ _id: "worker" });
    if (!s?.visto_em) return { online: false, visto_em: null };
    const minutos = (Date.now() - new Date(s.visto_em).getTime()) / 60000;
    // worker manda batida a cada 20s — 5min sem sinal = caiu
    return { online: minutos < 5, visto_em: s.visto_em, minutos: Math.round(minutos) };
  } catch {
    return { online: false, visto_em: null };
  }
}