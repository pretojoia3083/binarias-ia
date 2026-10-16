"""
Conversa com a IA sobre a operacao.

Diferente da `ai.py` (que da uma unica previsao e pronto), aqui a IA tem
CONTEXTO COMPLETO da operacao e conversa:

  - as velas e os indicadores dos 3 timeframes
  - as noticias relevantes de agora
  - a posicao aberta no momento
  - o historico recente e a assertividade
  - o que a propria IA ja disse antes (memoria do chat)

Ela responde em portugues, curta e direta, citando numeros reais.
Se ela quiser sugerir uma entrada, devolve no campo "sugestao" e o painel
transforma numa sugestao aprovavel — igual ao fluxo automatico.
"""
import json
from datetime import datetime

from openai import OpenAI

import ai as ai_mod
import news as news_mod
from settings import db, get_config, agora

MODELO_CHAT = "gpt-4o-mini"

PERSONA = """Voce e o analista do robo de operacoes binarias. Esta conversando
com o trader que opera a conta.

Como voce fala:
- Portugues do Brasil, direto e curto. 2 a 5 frases. Sem enrolacao.
- SEMPRE cite numeros reais que estao no contexto (preco, RSI, % de confianca,
  horario da noticia). Se nao tem o dado, fala que nao tem.
- Se o usuario perguntar algo que voce nao sabe, diz que nao sabe. Nunca inventa.
- Se ele perguntar "por que eu perdi", olha o historico e explica o que aconteceu
  de verdade, sem jogar a culpa nele.
- Se ele pedir para operar, voce sugere mas lembra que precisa da aprovacao dele
  no painel. Voce nao executa nada.
- Sem jargao de guru. Sem motivacao. Fale como um analista de mesa de operacoes.

Responda SEMPRE com JSON:
{
  "resposta": "texto que o usuario vai ler",
  "acao": null | "sugerir" | "explicar",
  "sugestao": null | {"ativo":"EURUSD-OTC","direcao":"CALL","confianca":70,"justificativa":"..."},
  "alerta": null | "mensagem curta de risco, se houver"
}"""


# ------------------------------------------------------------------ contexto


def _velas_texto(broker, ativo: str, timeframe: str, qtd: int = 60) -> str:
    try:
        velas = broker.candles(ativo, timeframe, quantidade=qtd)
    except Exception as e:  # noqa: BLE001
        return f"--- {timeframe} ---\nnao consegui puxar velas: {e}"
    if not velas:
        return f"--- {timeframe} ---\nsem dados"
    return f"--- {timeframe} ---\n{ai_mod.calcular_indicadores(velas)}"


def _historico_texto() -> str:
    d = db()
    stats = d.trades.aggregate([
        {"$match": {"status": {"$in": ["ganho", "perdido"]}}},
        {"$group": {"_id": None, "total": {"$sum": 1},
                    "ganhos": {"$sum": {"$cond": [{"$eq": ["$status", "ganho"]}, 1, 0]}},
                    "lucro": {"$sum": "$lucro"}}},
    ]).to_list()

    if stats:
        s = stats[0]
        t = s["total"] or 1
        linhas = [
            f"Total de operacoes fechadas: {s['total']} | acertos: {s['ganhos']} "
            f"| assertividade: {round(s['ganhos'] / t * 100, 1)}% | resultado: R$ {s['lucro']:+.2f}"
        ]
    else:
        linhas = ["Nenhuma operacao registrada ainda."]

    ultimos = list(d.trades.find({}, {"_id": 0}).sort("created_at", -1).limit(6))
    for t_ in ultimos:
        quando = t_.get("finalizado_em") or t_.get("created_at")
        marca = (quando.strftime("%d/%m %H:%M") if hasattr(quando, "strftime") else "?")
        linhas.append(
            f"  [{marca}] {t_.get('ativo')} {t_.get('direcao')} R$ {t_.get('valor')} "
            f"-> {t_.get('status')} (R$ {t_.get('lucro', 0):+.2f})"
        )
    return "\n".join(linhas)


def _posicao_aberta_texto() -> str:
    abertos = list(db().trades.find({"status": "aberto"}, {"_id": 0}).limit(5))
    if not abertos:
        return "Nenhuma posicao aberta no momento."
    linhas = []
    for p in abertos:
        desde = p.get("created_at")
        marca = desde.strftime("%H:%M") if hasattr(desde, "strftime") else "?"
        linhas.append(
            f"ABERTA: {p.get('ativo')} {p.get('direcao')} | R$ {p.get('valor')} "
            f"| expira em {p.get('expiracao')}min | aberta {marca} | ordem {p.get('order_id')}"
        )
    return "\n".join(linhas)


def montar_contexto(broker, ativo: str, minutos: int = 15) -> str:
    """Monta o bloco de texto com tudo que a IA precisa saber agora."""
    cfg = get_config()
    tfs = (cfg.get("ai") or {}).get("timeframes") or ["M1", "M5", "M15"]

    partes = [
        f"AGORA: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')} | ATIVO: {ativo.upper()} | "
        f"ALVO DA OPERACAO: {minutos} minutos",
        "",
        "=== VELAS E INDICADORES ===",
        "\n\n".join(_velas_texto(broker, ativo, tf) for tf in tfs),
        "",
        "=== NOTICIAS ===",
        news_mod.buscar_noticias(ativo, minutos, maximo=6)["resumo"],
        "",
        "=== POSICAO ABERTA AGORA ===",
        _posicao_aberta_texto(),
        "",
        "=== HISTORICO RECENTE ===",
        _historico_texto(),
        "",
        "=== O QUE A IA JA FALOU ANTES ===",
        _memoria_ia(),
        "",
        "=== CONFIG ATUAL ===",
        f"Valor por operacao: R$ {(cfg.get('trade') or {}).get('amount')} | "
        f"Expiracao: {(cfg.get('trade') or {}).get('expiration')}min | "
        f"Martingale: {'ON' if (cfg.get('trade') or {}).get('martingale') else 'OFF'} | "
        f"Confianca minima: {(cfg.get('ai') or {}).get('min_confidence')}%",
    ]
    return "\n".join(partes)


def _memoria_ia(n: int = 6) -> str:
    """As ultimas falas da IA automatica — ela nao deve se contradizer."""
    itens = list(
        db().sugestoes.find(
            {"analise": {"$exists": True}},
            {"_id": 0, "ativo": 1, "direcao": 1, "confianca": 1, "analise": 1, "status": 1, "created_at": 1},
        ).sort("created_at", -1).limit(n)
    )
    if not itens:
        return "A IA ainda nao deu nenhuma sugestao."
    linhas = []
    for i in itens:
        ts = i.get("created_at")
        marca = ts.strftime("%d/%m %H:%M") if hasattr(ts, "strftime") else "?"
        linhas.append(f"  [{marca}] {i.get('ativo')} {i.get('direcao')} {i.get('confianca')}% ({i.get('status')}): {i.get('analise')}")
    return "\n".join(linhas)


# ------------------------------------------------------------------ resposta


def _chave() -> str:
    import os
    chave = os.getenv("OPENAI_API_KEY", "")
    if chave:
        return chave
    try:
        return (db().config.find_one({"_id": "global"}) or {}).get("openai_key") or ""
    except Exception:  # noqa: BLE001
        return ""


def responder(broker, mensagens: list, ativo: str, minutos: int = 15,
              modelo: str = None) -> dict:
    """
    mensagens = [{"role":"user"|"assistant","content":"..."}, ...]
    Retorna {resposta, acao, sugestao, alerta, erro}
    """
    chave = _chave()
    if not chave:
        return {"resposta": "Nao tenho chave da OpenAI configurada. Coloque na aba Configuracao.",
                "acao": None, "sugestao": None, "alerta": None, "erro": "sem_chave"}

    contexto = montar_contexto(broker, ativo, minutos)

    # monta a conversa — ultimas 12 mensagens cabem no contexto
    historico = mensagens[-12:]
    corpo = "\n".join(
        f"{'TRADER' if m.get('role') == 'user' else 'IA'}: {m.get('content', '')}"
        for m in historico
    )

    prompt = f"""{contexto}

=== CONVERSA ===
{corpo}

Analista: responda a ultima mensagem do trader. Use os numeros do contexto."""

    try:
        r = OpenAI(api_key=chave, timeout=60.0).chat.completions.create(
            model=modelo or (get_config().get("ai") or {}).get("model") or MODELO_CHAT,
            messages=[
                {"role": "system", "content": PERSONA},
                {"role": "user", "content": prompt},
            ],
            temperature=0.6,   # conversa precisa variar um pouco, nao prever
            response_format={"type": "json_object"},
        )
        dados = json.loads(r.choices[0].message.content or "{}")

        sugestao = dados.get("sugestao")
        if isinstance(sugestao, dict):
            d = str(sugestao.get("direcao", "")).upper()
            sugestao = {
                "ativo": str(sugestao.get("ativo", ativo)).upper(),
                "direcao": d if d in ("CALL", "PUT") else None,
                "confianca": max(0, min(100, int(float(sugestao.get("confianca", 0) or 0)))),
                "justificativa": str(sugestao.get("justificativa", ""))[:400],
            }
            if not sugestao["direcao"]:
                sugestao = None

        return {
            "resposta": str(dados.get("resposta", ""))[:1200],
            "acao": dados.get("acao"),
            "sugestao": sugestao,
            "alerta": dados.get("alerta"),
            "erro": None,
        }
    except Exception as e:  # noqa: BLE001
        return {"resposta": f"Falha ao falar com a IA: {e}", "acao": None,
                "sugestao": None, "alerta": None, "erro": str(e)}


def registrar_sugestao_do_chat(ativo: str, direcao: str, confianca: int,
                               justificativa: str) -> dict:
    """Grava a sugestao proposta no chat como pendente de aprovacao."""
    cfg = get_config()
    exp = int((cfg.get("trade") or {}).get("expiration", 15))
    doc = {
        "created_at": agora(),
        "ativo": ativo.upper(),
        "direcao": direcao,
        "confianca": confianca,
        "analise": f"[via chat] {justificativa}",
        "noticias": "",
        "expiracao": exp,
        "valor": (cfg.get("trade") or {}).get("amount", 10.0),
        "timeframes": (cfg.get("ai") or {}).get("timeframes", ["M1", "M5", "M15"]),
        "status": "pendente",
        "origem_extra": {"tipo": "chat"},
        "modelo": (cfg.get("ai") or {}).get("model", ai_mod.MODELO_PADRAO),
    }
    db().sugestoes.insert_one(doc)
    return {"id": str(doc["_id"]), "ativo": doc["ativo"], "direcao": direcao,
            "confianca": confianca, "expiracao": exp, "valor": doc["valor"]}