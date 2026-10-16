"""
Funcao 2 — Execuicao da lista de sinais.

O usuario cola no painel a lista de sinais (texto livre ou JSON). Este arquivo
transforma esse texto em sinais estruturados: {timeframe, ativo, hora, direcao}.

Exemplos de entrada aceita:

  JSON:
    [{"timeframe":"M1","active":"USDARS-OTC","time":"15:42","direction":"CALL"}]

  Texto (um sinal por linha):
    M1 USDARS-OTC 15:42 CALL
    15:42 USDARS-OTC CALL M1
    EURUSD OTC 15:42 PUT
"""
import json
import re

# "• M1", "- M1", "| M1" -> o sinal colado costuma vir com bullet
_LIXO = re.compile(r"^[\s\-\*\u2022\u25aa\u2023|]+")
_TIMEFRAME = re.compile(r"\b(M1|M5|M15|M30|H1)\b", re.I)
_HORA = re.compile(r"\b([0-2]?\d)[:h]([0-5]\d)\b", re.I)
_DIRECAO = re.compile(r"\b(CALL|PUT|COMPRA|VENDA|ACIMA|ABAIXO|ALTA|BAIXA)\b", re.I)
_ATIVO = re.compile(r"\b([A-Z]{6})[- ]?(OTC)?\b")

# normaliza sinonimos de direcao
_DIRECAO_MAP = {
    "CALL": "CALL", "COMPRA": "CALL", "ACIMA": "CALL", "ALTA": "CALL",
    "PUT": "PUT", "VENDA": "PUT", "ABAIXO": "PUT", "BAIXA": "PUT",
}

# pares OTC mais comuns — usada para validar antes de salvar
ATIVOS_CONHECIDOS = {
    "EURUSD-OTC", "GBPUSD-OTC", "USDJPY-OTC", "AUDUSD-OTC", "USDCHF-OTC",
    "USDCAD-OTC", "EURJPY-OTC", "EURGBP-OTC", "NZDUSD-OTC", "USDARS-OTC",
    "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "ETHUSD", "GOLD", "OIL",
}


def _normalizar_ativo(texto: str):
    m = _ATIVO.search(texto.upper())
    if not m:
        return None
    par, otc = m.group(1), m.group(2)
    return f"{par}-{otc}" if otc else par


def _normalizar_hora(texto: str):
    m = _HORA.search(texto)
    if not m:
        return None
    h, m2 = int(m.group(1)), int(m.group(2))
    if h > 23 or m2 > 59:
        return None
    return f"{h:02d}:{m2:02d}"


def parse_texto(texto: str) -> list:
    """Quebra o texto em sinais. Linhas sem sinal reconhecivel sao ignoradas."""
    sinais = []
    for linha in texto.splitlines():
        limpa = _LIXO.sub("", linha).strip()
        if not limpa:
            continue

        tf = _TIMEFRAME.search(limpa)
        direcao = _DIRECAO.search(limpa)
        hora = _normalizar_hora(limpa)
        ativo = _normalizar_ativo(limpa)

        if not (tf and direcao and hora and ativo):
            continue

        sinais.append(
            {
                "timeframe": tf.group(1).upper(),
                "active": ativo,
                "time": hora,
                "direction": _DIRECAO_MAP[direcao.group(1).upper()],
            }
        )
    return sinais


def parse_entrada(bruto: str) -> dict:
    """
    Aceita JSON ou texto solto.
    Retorna {"sinais": [...], "ignoradas": int, "erro": str|None}
    """
    if not bruto or not bruto.strip():
        return {"sinais": [], "ignoradas": 0, "erro": "Lista vazia."}

    texto = bruto.strip()

    # 1) tenta JSON
    try:
        dados = json.loads(texto)
        if isinstance(dados, dict):
            dados = dados.get("sinais") or dados.get("signals") or []
        if isinstance(dados, list):
            normalizados, ignoradas = [], 0
            for item in dados:
                if not isinstance(item, dict):
                    ignoradas += 1
                    continue
                tf = str(item.get("timeframe", "M1")).upper().replace(" ", "")
                if tf not in ("M1", "M5", "M15", "M30", "H1"):
                    tf = "M1"
                ativo = str(item.get("active") or item.get("pair") or "").upper().strip()
                hora = _normalizar_hora(str(item.get("time") or item.get("hora") or ""))
                dir_txt = str(item.get("direction") or item.get("direcao") or "").upper().strip()
                if not (ativo and hora and dir_txt in _DIRECAO_MAP):
                    ignoradas += 1
                    continue
                normalizados.append(
                    {
                        "timeframe": tf,
                        "active": ativo,
                        "time": hora,
                        "direction": _DIRECAO_MAP[dir_txt],
                    }
                )
            if normalizados:
                return {"sinais": normalizados, "ignoradas": ignoradas, "erro": None}
    except json.JSONDecodeError:
        pass  # nao era JSON, cai para o texto

    # 2) texto solto
    linhas = [l for l in texto.splitlines() if l.strip()]
    sinais = parse_texto(texto)
    ignoradas = len(linhas) - len(sinais)

    if not sinais:
        return {
            "sinais": [],
            "ignoradas": ignoradas,
            "erro": (
                "Nao consegui ler nenhum sinal. Use uma linha por sinal:\n"
                "M1 USDARS-OTC 15:42 CALL"
            ),
        }
    return {"sinais": sinais, "ignoradas": ignoradas, "erro": None}