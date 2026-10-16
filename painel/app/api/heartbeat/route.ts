import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

/**
 * POST /api/heartbeat — o worker avisa que esta vivo.
 * Sem autenticacao porque nao ha dado sensivel aqui (so um "last seen").
 */
export async function POST() {
  try {
    await getDb()
      .collection<any>("status") // _id e a string "worker"
      .updateOne(
        { _id: "worker" },
        { $set: { online: true, visto_em: new Date() } },
        { upsert: true }
      );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}