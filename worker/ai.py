"""
Funcao 1 — Analise pela IA.

Pega as velas de M1, M5 e M15, calcula indicadores tecnicos localmente e
manda tudo pro GPT, que responde se nos proximos N minutos o ativo sobe (CALL)
ou desce (PUT), com nivel de confianca e justificativa.

A IA NUNCA executa sozinha. Ela grava uma sugestao com status "pendente" e
espera o usuario aprovar no painel.
"""
import json
import os

from openai import OpenAI

from broker import BrokerError  # noqa: F401  (mantido p/ documentacao)
from settings import OPENAI_API_KEY, registrar_log

MODELO_PADRAO = "gpt-4o-mini"

SYSTEM_PROMPT = """Voce e um analista tecnico e de noticias especializado em operacoes
binarias de 1 a 15 minutos.

Voce recebe as velas reais de um ativo em 3 periodos (M1, M5 e M15), os indicadores
ja calculados e as noticias do mercado relevantes para aquele par.
Sua tarefa e prever a direcao do preco nos proximos minutos.

Como pesar as tres fontes:

1. NOTICIAS — e o fator mais importante. Inflacao, decisao de banco central,
   tarifa, guerra, dado de emprego ou qualquer titulo pode virar o preco em
   segundos. Se a noticia for forte E recente, ela domina a previsao: leia o
   titulo E o resumo. Noticia de alta impacto nao confirmada pela vela ainda e
   o cenário mais perigoso de binaria — se houver uma, reduza a confianca.
2. TIMEFRAME M1 — o que esta acontecendo agora. E o que mais pesa na direcao.
3. M5 e M15 — o contexto. Servem para saber se o movimento faz sentido com a
   tendencia maior, mas nao definem os proximos 5 minutos.

Regras:
- Responda SEMPRE com JSON valido e nada mais. Sem texto fora do JSON.
- Campos obrigatorios: "direcao" ("CALL" ou "PUT"), "confianca" (inteiro 0-100),
  "analise" (texto curto em portugues, 2 a 4 frases).
- "confianca" e a sua conviccao real. Se os indicadores se contradizem, se o
  mercado esta lateral ou se ha noticia relevante SEM confirmacao na vela,
  use confianca abaixo de 60. Nao e obrigado a operar.
- Se as noticias forem a favor e contra ao mesmo tempo, a confianca cai muito.
- Seja honesto. Nao invente tendencia. Nao invente horario de dado economico
  que nao esteja escrito para voce.
- Cite a noticia que mais pesou na sua decisao dentro do campo "analise"."""

PROMPT_USUARIO = """ATIVO: {ativo}
Alvo: prever os proximos {minutos} minutos.
Horario da analise: {hora}

=== INDICADORES TECNICOS ===
{indicadores}

=== NOTICIAS DO MERCADO ===
{noticias}
{calendario}

Responda o JSON com direcao, confianca e analise."""


# ------------------------------------------------------------------ indicadores


def _ema(valores: float, periodo: int) -> float:
    if not valores:
        return 0.0
    k = 2 / (periodo + 1)
    e = valores[0]
    for v in valores[1:]:
        e = v * k + e * (1 - k)
    return e


def _rsi(fechamentos: list, periodo: int = 14) -> float:
    if len(fechamentos) < periodo + 1:
        return 50.0
    ganhos, perdas = [], []
    for i in range(1, len(fechamentos)):
        d = fechamentos[i] - fechamentos[i - 1]
        ganhos.append(max(d, 0))
        perdas.append(max(-d, 0))
    g = sum(ganhos[-periodo:]) / periodo
    p = sum(perdas[-periodo:]) / periodo
    if p == 0:
        return 100.0 if g > 0 else 50.0
    rs = g / p
    return 100 - (100 / (1 + rs))


def _bollinger(fechamentos: list, periodo: int = 20, mult: float = 2.0):
    if len(fechamentos) < periodo:
        return None
    janela = fechamentos[-periodo:]
    media = sum(janela) / periodo
    var = sum((x - media) ** 2 for x in janela) / periodo
    desvio = var**0.5
    return media, media + desvio * mult, media - desvio * mult


def resumir_vela(v) -> str:
    direcao = "alta" if v["c"] > v["o"] else ("queda" if v["c"] < v["o"] else "estavel")
    corpo = abs(v["c"] - v["o"])
    pavio_sup = v["h"] - max(v["o"], v["c"])
    pavio_inf = min(v["o"], v["c"]) - v["l"]
    nota = "forte" if corpo > 0 else "fraca"
    return f"{v['dt']} {direcao} {nota} (o{v['o']} h{v['h']} l{v['l']} c{v['c']})"


def calcular_indicadores(velas: list) -> str:
    """Transforma velas em um bloco de texto legivel para o GPT."""
    if not velas:
        return "sem dados"

    fech = [v["c"] for v in velas]
    linhas = [f"{len(velas)} velas | ultima {velas[-1]['dt']} | preco {fech[-1]}"]

    e9, e21 = _ema(fech, 9), _ema(fech, 21)
    tend = "ALTA" if e9 > e21 else "QUEDA"
    forca = abs(e9 - e21) / fech[-1] * 100 if fech[-1] else 0

    linhas += [
        f"EMA9={e9:.5f} EMA21={e21:.5f} -> tendencia {tend} (forca {forca:.3f}%)",
        f"RSI14={_rsi(fech):.1f}"
        + (" (sobrevendido)" if _rsi(fech) < 30 else " (sobrecomprado)" if _rsi(fech) > 70 else ""),
    ]

    bb = _bollinger(fech)
    if bb:
        media, sup, inf = bb
        pos = (fech[-1] - inf) / (sup - inf) * 100 if sup != inf else 50
        linhas.append(f"Bollinger20: sup={sup:.5f} media={media:.5f} inf={inf:.5f} (posicao {pos:.0f}%)")

    ultimas5 = sum(1 for v in velas[-5:] if v["c"] > v["o"])
    linhas.append(f"ULTIMAS 5 VELAS: {ultimas5} de alta / {5 - ultimas5} de queda")
    linhas.append("VELAS RECENTES: " + " | ".join(resumir_vela(v) for v in velas[-8:]))
    return "\n".join(linhas)


# ------------------------------------------------------------------ chamada


def _chave() -> str:
    """
    Chave da OpenAI. Ordem de prioridade:
      1. variavel de ambiente do Railway (mais segura)
      2. chave enviada pelo painel (fica no Mongo)
    """
    return os.getenv("OPENAI_API_KEY") or OPENAI_API_KEY or ""


def analisar(ativo: str, minutos: int, candles_por_tf: dict,
            modelo: str = MODELO_PADRAO, contexto_noticias: str = None) -> dict:
    """
    candles_por_tf = {"M1": [velas], "M5": [...], "M15": [...]}
    contexto_noticias = texto ja montado por news.buscar_noticias()['resumo']

    Retorna {"direcao","confianca","analise","noticias","erro"} — erro preenchido em falha.
    """
    chave = os.getenv("OPENAI_API_KEY") or OPENAI_API_KEY or ""
    if not chave:
        # fallback: chave que o usuario enviou pelo painel
        try:
            from settings import db
            chave = (db().config.find_one({"_id": "global"}) or {}).get("openai_key") or ""
        except Exception:  # noqa: BLE001
            chave = ""

    if not chave:
        return {
            "direcao": None, "confianca": 0, "analise": "Sem chave da OpenAI configurada.",
            "noticias": [], "erro": "sem_chave",
        }

    from datetime import datetime

    blocos = []
    for tf, velas in candles_por_tf.items():
        if not velas:
            blocos.append(f"--- {tf} ---\nsem dados")
            continue
        blocos.append(f"--- {tf} ---\n{calcular_indicadores(velas)}")

    import news

    if contexto_noticias is None:
        contexto_noticias = news.buscar_noticias(ativo, minutos)["resumo"]

    prompt = PROMPT_USUARIO.format(
        ativo=ativo.upper(),
        minutos=minutos,
        hora=datetime.now().strftime("%H:%M:%S"),
        indicadores="\n\n".join(blocos),
        noticias=contexto_noticias,
        calendario=(
            "" if "SEM FONTES" in (contexto_noticias or "")
            else news.evento_de_calendario_proximo()
        ),
    )

    try:
        resposta = OpenAI(api_key=chave, timeout=60.0).chat.completions.create(
            model=modelo or MODELO_PADRAO,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,          # baixa: consistencia, nao criatividade
            response_format={"type": "json_object"},
        )
        bruto = resposta.choices[0].message.content or "{}"
        dados = json.loads(bruto)

        direcao = str(dados.get("direcao", "")).upper().strip()
        if direcao not in ("CALL", "PUT"):
            direcao = None

        return {
            "direcao": direcao,
            "confianca": max(0, min(100, int(float(dados.get("confianca", 0))))),
            "analise": str(dados.get("analise", ""))[:800],
            "noticias": contexto_noticias,
            "erro": None,
        }
    except Exception as e:  # noqa: BLE001
        registrar_log(f"Erro na IA ({ativo}): {e}", "erro", "ia")
        return {
            "direcao": None, "confianca": 0,
            "analise": f"Falha ao consultar a IA: {e}",
            "noticias": contexto_noticias,
            "erro": str(e),
        }