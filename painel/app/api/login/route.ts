import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { login, logout, autenticado } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/login  { senha } */
export async function POST(req: NextRequest) {
  const { senha } = await req.json().catch(() => ({}));
  return login(req, String(senha || ""));
}

/** DELETE /api/login — sai da sessao */
export async function DELETE() {
  return logout();
}

/** GET /api/login — o front pergunta se ja esta logado */
export async function GET(req: NextRequest) {
  return NextResponse.json({ autenticado: autenticado(req) });
}