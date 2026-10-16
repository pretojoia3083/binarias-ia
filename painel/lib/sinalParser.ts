/**
 * Parser da lista de sinais — versao TypeScript do signals.py do worker.
 *
 * Os dois precisam entender o MESMO formato. Se mudar um, mude o outro.
 *
 * Aceita:
 *   JSON:  [{"timeframe":"M1","active":"USDARS-OTC","time":"15:42","direction":"CALL"}]
 *   Texto: uma linha por sinal, ex: "M1 USDARS-OTC 15:42 CALL"
 *
 * Tolera bullet ("• M1"), e sinonimos: COMPRA/CALL/ACIMA/ALTA, VENDA/PUT/ABAIXO/BAIXA.
 */

export type Sinal = {
  timeframe: string;
  active: string;
  time: string;
  direction: "CALL" | "PUT";
};

export type ResultadoParse = {
  sinais: Sinal[];
  ignoradas: number;
  erro: string | null;
};

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1"];
const LIXO = /^[\s\-*•▪‣|]+/;

const RE_TF = /\b(M1|M5|M15|M30|H1)\b/i;
const RE_HORA = /\b([0-2]?\d)[:h]([0-5]\d)\b/i;
const RE_DIR = /\b(CALL|PUT|COMPRA|VENDA|ACIMA|ABAIXO|ALTA|BAIXA)\b/i;
const RE_ATIVO = /\b([A-Z]{6})[- ]?(OTC)?\b/;

const MAPA_DIR: Record<string, "CALL" | "PUT"> = {
  CALL: "CALL", COMPRA: "CALL", ACIMA: "CALL", ALTA: "CALL",
  PUT: "PUT", VENDA: "PUT", ABAIXO: "PUT", BAIXA: "PUT",
};

function normalizarHora(texto: string): string | null {
  const m = RE_HORA.exec(texto);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalizarAtivo(texto: string): string | null {
  const m = RE_ATIVO.exec(texto.toUpperCase());
  if (!m) return null;
  const [, par, otc] = m;
  return otc ? `${par}-${otc}` : par;
}

/** Converte texto solto em sinais. */
export function parseTexto(texto: string): Sinal[] {
  const saida: Sinal[] = [];
  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.replace(LIXO, "").trim();
    if (!limpa) continue;

    const tf = RE_TF.exec(limpa);
    const dir = RE_DIR.exec(limpa);
    const hora = normalizarHora(limpa);
    const ativo = normalizarAtivo(limpa);

    if (!tf || !dir || !hora || !ativo) continue;

    saida.push({
      timeframe: tf[1].toUpperCase(),
      active: ativo,
      time: hora,
      direction: MAPA_DIR[dir[1].toUpperCase()],
    });
  }
  return saida;
}

/** Ponto de entrada unico: aceita JSON ou texto. */
export function parseEntrada(bruto: string): ResultadoParse {
  const texto = (bruto || "").trim();

  if (!texto) {
    return { sinais: [], ignoradas: 0, erro: "Lista vazia." };
  }

  // 1) tenta JSON
  try {
    const dados = JSON.parse(texto);
    const lista = Array.isArray(dados)
      ? dados
      : dados?.sinais || dados?.signals || [];

    if (Array.isArray(lista)) {
      const norm: Sinal[] = [];
      let ignoradas = 0;

      for (const item of lista) {
        if (!item || typeof item !== "object") { ignoradas++; continue; }

        const rawTf = String(item.timeframe ?? "M1").toUpperCase().replace(/\s/g, "");
        const timeframe = TIMEFRAMES.includes(rawTf) ? rawTf : "M1";

        const active = String(item.active ?? item.pair ?? "").toUpperCase().trim();
        const time = normalizarHora(String(item.time ?? item.hora ?? ""));
        const dirBruto = String(item.direction ?? item.direcao ?? "").toUpperCase().trim();
        const direction = MAPA_DIR[dirBruto];

        if (!active || !time || !direction) { ignoradas++; continue; }

        norm.push({ timeframe, active, time, direction });
      }

      if (norm.length) return { sinais: norm, ignoradas, erro: null };
    }
  } catch {
    // nao era JSON — cai para o texto
  }

  // 2) texto solto
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  const sinais = parseTexto(texto);

  if (!sinais.length) {
    return {
      sinais: [],
      ignoradas: linhas.length,
      erro: "Nao consegui ler nenhum sinal. Use uma linha por sinal:\nM1 USDARS-OTC 15:42 CALL",
    };
  }

  return { sinais, ignoradas: linhas.length - sinais.length, erro: null };
}