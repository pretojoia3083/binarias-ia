import { NextRequest, NextResponse } from "next/server";

/**
 * Autenticacao simples por senha.
 * A senha vem da variavel PANEL_PASSWORD.
 * Guardamos so um token no cookie — nunca a senha.
 */
const COOKIE = "painel_token";
const TOKEN = process.env.PANEL_TOKEN || "binarias-ia-acesso";

export function autenticado(req: NextRequest): boolean {
  return req.cookies.get(COOKIE)?.value === TOKEN;
}

export function exigirAuth(req: NextRequest): NextResponse | null {
  if (autenticado(req)) return null;
  return NextResponse.json({ erro: "Nao autenticado" }, { status: 401 });
}

export function rotaProtegida<T>(req: NextRequest, fn: () => Promise<T> | T) {
  const bloqueio = exigirAuth(req);
  if (bloqueio) return bloqueio;
  try {
    const r = fn();
    return r instanceof Promise ? r.then((v) => NextResponse.json(v)) : NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ erro: e?.message || "erro interno" }, { status: 500 });
  }
}

export function login(req: NextRequest, senha: string) {
  if (senha !== (process.env.PANEL_PASSWORD || "")) {
    return NextResponse.json({ erro: "Senha incorreta" }, { status: 401 });
  }
  const resp = NextResponse.json({ ok: true });
  resp.cookies.set(COOKIE, TOKEN, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return resp;
}

export function logout() {
  const resp = NextResponse.json({ ok: true });
  resp.cookies.delete(COOKIE);
  return resp;
}