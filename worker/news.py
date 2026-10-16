"""
Pesquisa de noticias para a IA.

Antes de pedir a previsao, o worker junta o que saiu no mercado agora ha pouco
e filtra o que tem a ver com o ativo. Isso muda decisao em binaria de 15min:
inflacao, decisao de banco central, tariff, guerra, petroleo.

Fontes: RSS publicas e gratuitas (sem chave de API).
Cache de 5 minutos — nao faz sentido baixar os feeds a cada 60s.

Retorna:
  {"noticias": [...], "eventos": [...], "resumo": "...", "erro": None}
"""
import re
import threading
import time
from datetime import datetime, timedelta

import feedparser

# ------------------------------------------------------------------ fontes

# (nome, url, peso) — peso maior = mais importante para o par
FONTES = [
    ("ForexLive", "https://www.forexlive.com/feed", 3),
    ("Investing.com BR", "https://br.investing.com/rss/news.rss", 3),
    ("Investing.com", "https://www.investing.com/rss/news.rss", 2),
    ("InfoMoney", "https://www.infomoney.com.br/feed/", 3),
    ("ECB (Banco Central Europa)", "https://www.ecb.europa.eu/rss/press.html", 2),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", 2),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", 1),
    ("CNBC Mercados", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147", 1),
]

# ------------------------------------------------------------------ relevancia

# termos que mexem em qualquer par de moeda
MACRO = {
    "banco central": 3, "fed": 3, "fomc": 3, "ecb": 3, "copom": 3, "bcb": 3,
    "inflacao": 3, "inflation": 3, "ipca": 3, "cpi": 3, "ppi": 3,
    "juros": 3, "interest rate": 3, "taxa de juros": 3, "yield": 2,
    "dolar": 3, "dollar": 3, "dxy": 3, "forex": 2, "cambio": 3, "currency": 2,
    "emprego": 2, "payroll": 3, "nonfarm": 3, "desemprego": 2,
    "petroleo": 2, "oil": 2, "crude": 2, "ouro": 1, "gold": 1,
    "tarifa": 3, "tariff": 3, "guerra": 3, "war": 2, "sancao": 3, "sanction": 3,
    "eleicao": 2, "election": 2, "orcamento": 2, "budget": 2,
    "bolha": 2, "bubble": 2, "crise": 2, "crash": 3, "risk": 2,
    "bitcoin": 2, "crypto": 2, "ethereum": 2,
    "china": 2, "europa": 2, "eua": 2, "brasil": 2,
}

_LIMPEZA = re.compile(r"<[^>]+>")
_TAG = re.compile(r"<[^>]+>")


def _limpar(texto: str, limite: int = 200) -> str:
    return _LIMPEZA.sub(" ", texto or "").replace("\n", " ").strip()[:limite]


def moedas_do_ativo(ativo: str) -> list:
    """EURUSD-OTC -> ['EUR', 'USD']. Cripto e metais nao tem moeda dupla."""
    a = (ativo or "").upper().replace("-OTC", "")
    if a.isalpha() and len(a) >= 6 and not a.startswith(("BTC", "ETH")):
        return [a[:3], a[3:6]]
    return []


def _tamanho(a: str, b: str) -> int:
    return min(12, len((a or "").strip()) + len((b or "").strip()))


def avaliar_relevancia(titulo: str, resumo: str, ativo: str) -> int:
    """Nota 0-10 de quanto a noticia afeta o ativo. 0 = ignora."""
    texto = f"{titulo} {resumo}".lower()
    nota = 0

    for termo, peso in MACRO.items():
        if termo in texto:
            nota += peso

    for moeda in moedas_do_ativo(ativo):
        nome = {"USD": "dolar", "EUR": "euro", "GBP": "libra", "JPY": "iene",
                "AUD": "dolar australiano", "CAD": "dolar canada", "CHF": "franco",
                "ARS": "peso argentino", "NZD": "dolar neozelandez"}.get(moeda, moeda.lower())
        if moeda.lower() in texto:
            nota += 3
        elif nome in texto:
            nota += 2

    ativo_limpo = (ativo or "").upper().replace("-OTC", "")
    if ativo_limpo and ativo_limpo in texto:
        nota += 4

    return min(10, nota)


def _hora_de(entry):
    """Timestamp do item, ja em UTC. Retorna None se nao houver."""
    for campo in ("published_parsed", "updated_parsed", "created_parsed"):
        v = entry.get(campo)
        if v:
            try:
                return datetime(*v[:6]) + timedelta(seconds=0)
            except (TypeError, ValueError):
                continue
    return None


# ------------------------------------------------------------------ cache

_cache = {"dados": None, "ts": 0.0}
_cache_lock = threading.Lock()

MAX_HORAS = 12      # noticias mais velhas que isso nao interessam
CACHE_SEG = 300     # 5 minutos


def _baixar_fontes():
    """Baixa todos os feeds em paralelo e devolve lista de itens crus."""
    itens = []

    def baixar(nome, url, peso):
        try:
            d = feedparser.parse(url)
            for e in d.entries[:25]:
                titulo = _limpar(e.get("title", ""), 160)
                resumo = _limpar(
                    e.get("summary", "") or (e.get("description", "") if isinstance(e.get("description"), str) else ""),
                    260,
                )
                if not titulo:
                    continue
                itens.append({
                    "fonte": nome,
                    "peso_fonte": peso,
                    "titulo": titulo,
                    "resumo": resumo,
                    "ts": _hora_de(e),
                    "link": e.get("link", ""),
                })
        except Exception:  # noqa: BLE001 — uma fonte ruim nao pode derrubar o robo
            pass

    threads = [threading.Thread(target=baixar, args=f, daemon=True) for f in FONTES]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=12)  # nunca trava esperando uma fonte lenta
    return itens


def coletar_todas(force: bool = False) -> list:
    """Itens frescos de todas as fontes, respeitando o cache."""
    agora = time.time()
    with _cache_lock:
        if not force and _cache["dados"] and (agora - _cache["ts"]) < CACHE_SEG:
            return _cache["dados"]
    dados = _baixar_fontes()
    with _cache_lock:
        _cache["dados"] = dados
        _cache["ts"] = time.time()
    return dados


# ------------------------------------------------------------------ publico


def buscar_noticias(ativo: str, minutos: int = 15, maximo: int = 8) -> dict:
    """
    Monta o contexto de noticias para a IA ler.

    Prioridade:
      1. noticia recente E relevante pro ativo
      2. noticia muito relevante (nota >= 6), mesmo com mais de 1h
      3. headlines gerais de mercado, para o clima geral

    minutos = horizonte da operacao. noticia dentro dessa janela pesa mais.
    """
    agora = datetime.utcnow()
    itens = coletar_todas()
    if not itens:
        return {"noticias": [], "resumo": "SEM FONTES DE NOTICIA DISPONIVEIS", "erro": "sem_fontes"}

    selecionados, vistos = [], set()

    for item in sorted(itens, key=lambda x: x.get("peso_fonte", 0), reverse=True):
        chave = item["titulo"][:60].lower()
        if chave in vistos:
            continue

        ts = item.get("ts")
        if ts and ts > agora + timedelta(hours=6):   # data no futuro = feed quebrado
            continue

        idade_h = (agora - ts).total_seconds() / 3600 if ts else 99
        if idade_h > MAX_HORAS:
            continue

        nota = avaliar_relevancia(item["titulo"], item["resumo"], ativo)
        if nota <= 0:
            continue

        # bonus para noticia bem na hora da operacao
        if ts and idade_h <= (minutos / 60.0) + 0.5:
            nota += 3

        vistos.add(chave)
        selecionados.append({
            "titulo": item["titulo"],
            "fonte": item["fonte"],
            "idade": "agora" if idade_h < 1 else f"{int(idade_h)}h atras",
            "nota": min(10, nota),
            "resumo": item["resumo"],
        })

    selecionados.sort(key=lambda x: x["nota"], reverse=True)

    if not selecionados:
        return {
            "noticias": [],
            "resumo": "Nenhuma noticia relevante para este ativo nas ultimas 12 horas.",
            "erro": None,
        }

    linhas = [f"{len(selecionados)} noticia(s) relevante(s) para {ativo.upper()}:"]
    for n in selecionados[:maximo]:
        linhas.append(f"- [relevancia {n['nota']}/10 | {n['fonte']} | {n['idade']}] {n['titulo']}")
        if n["resumo"]:
            linhas.append(f"    {n['resumo'][:180]}")

    return {"noticias": selecionados[:maximo], "resumo": "\n".join(linhas), "erro": None}


def evento_de_calendario_proximo(minutos: int = 30) -> str:
    """
    Os RSS de calendario economico (ForexFactory, TradingEconomics, Investing)
    estao bloqueados e devolvem vazio. Deixa isso explicito no prompt para a IA
    saber que ela NAO tem essa informacao e nao inventar horario de dado.
    """
    return (
        "ATENCAO: nao tenho acesso ao calendario economico (datas de divulgacao).\n"
        "Nao invente horarios de dados. Se algum dado relevante puder ser publicado "
        "nas proximas horas, aumente o risco e reduza a confianca."
    )