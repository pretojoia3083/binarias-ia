import { NextRequest } from "next/server";
import { rotaProtegida } from "@/lib/auth";
import { parseEntrada } from "@/lib/sinalParser";

export const dynamic = "force-dynamic";

/**
 * POST /api/sinais/parse — so a previa, nao grava nada.
 * O front chama enquanto o usuario cola, para mostrar quantos sinais leu
 * antes de salvar.
 */
export async function POST(req: NextRequest) {
  return rotaProtegida(req, async () => {
    const { texto } = await req.json().catch(() => ({}));
    return parseEntrada(String(texto || ""));
  });
}