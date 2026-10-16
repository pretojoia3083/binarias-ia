"""
Camada de configuracao e banco de dados.
Compartilhada entre o worker (Railway) e o painel (Vercel) via MongoDB.

Variaveis de ambiente (Railway / .env local):
  MONGO_URI     -> string de conexao do MongoDB
  OPENAI_API_KEY-> chave da OpenAI
  EXNOVA_EMAIL  -> login da corretora
  EXNOVA_PASS   -> senha da corretora
  EXNOVA_ACCOUNT-> PRACTICE (demo) ou REAL
  PORT          -> porta do servidor web de healthcheck (Railway injeta)
"""
import os
import threading
from datetime import datetime, timezone

from pymongo import MongoClient

# ---------------------------------------------------------------- variaveis

MONGO_URI = os.getenv("MONGO_URI", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Database padrao "binarias_ia" — painel e worker apontam para o mesmo
DB_NAME = os.getenv("MONGO_DB", "binarias_ia")

# ---------------------------------------------------------------- mongo

_lock = threading.Lock()
_client = None


def client() -> MongoClient:
    """Conexao singleton com o Mongo (MongoClient e thread-safe)."""
    global _client
    with _lock:
        if _client is None:
            if not MONGO_URI:
                raise RuntimeError("MONGO_URI nao configurada")
            _client = MongoClient(
                MONGO_URI,
                serverSelectionTimeoutMS=8000,
                connectTimeoutMS=8000,
            )
    return _client


def db():
    return client()[DB_NAME]


def agora():
    """Datetime UTC aware - padrao do projeto."""
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- config

# Documento unico de configuracao (_id = "global").
# O painel escreve, o worker le.
CONFIG_PADRAO = {
    "_id": "global",
    "broker": {
        "email": "",
        "password": "",
        "account_type": "PRACTICE",  # PRACTICE = demo | REAL = dinheiro
    },
    "trade": {
        "active": "EURUSD-OTC",
        "amount": 10.0,
        "expiration": 15,        # minutos (expiracao da operacao)
        "martingale": False,
        "mart_mult": 2.2,
        "mart_steps": 3,
    },
    "ai": {
        "enabled": True,
        "model": "gpt-4o-mini",
        "timeframes": ["M1", "M5", "M15"],
        "interval_sec": 60,     # de quanto em quanto tempo a IA analisa
        "min_confidence": 70,   # abaixo disso a IA se cala (NAO opera)
        "usar_noticias": True,  # IA pesquisa noticias antes de opinar
        "noticias_max": 8,      # quantas noticias entram no prompt
    },
    "sinais": {
        "enabled": False,
        "auto_confirmar": False,  # True = executa o sinal sem perguntar
    },
    "updated_at": None,
}


def get_config():
    """Le a config global, criando com os padroes se ainda nao existir."""
    d = db()
    if d.config.find_one({"_id": "global"}) is None:
        d.config.insert_one(dict(CONFIG_PADRAO))
    return d.config.find_one({"_id": "global"})


def get_config_value(caminho: str, padrao=None):
    """Le valor aninhado com notacao de ponto: 'trade.amount', 'ai.model'."""
    doc = get_config()
    atual = doc
    for parte in caminho.split("."):
        if not isinstance(atual, dict) or parte not in atual:
            return padrao
        atual = atual[parte]
    return atual


def salvar_config(parcial: dict):
    """
    Merge na profundidade correta e grava.
    Ex: salvar_config({'trade': {'amount': 25}}) so muda trade.amount.
    """
    d = db()

    def merge(destino, novo):
        for k, v in novo.items():
            if isinstance(v, dict) and isinstance(destino.get(k), dict):
                merge(destino[k], v)
            else:
                destino[k] = v

    atual = d.config.find_one({"_id": "global"}) or dict(CONFIG_PADRAO)
    atual.pop("_id", None)
    merge(atual, parcial)
    atual["updated_at"] = agora()
    d.config.replace_one({"_id": "global"}, {**atual, "_id": "global"}, upsert=True)
    return d.config.find_one({"_id": "global"})


# ---------------------------------------------------------------- logs

NIVEIS = ("info", "aviso", "erro")


def registrar_log(mensagem: str, nivel: str = "info", origem: str = "worker"):
    """Grava log no banco — o painel mostra na aba de logs."""
    if nivel not in NIVEIS:
        nivel = "info"
    db().logs.insert_one(
        {
            "ts": agora(),
            "nivel": nivel,
            "origem": origem,
            "msg": mensagem,
        }
    )


def limpar_logs(mais_antigos_que_dias=7):
    from datetime import timedelta

    limite = agora() - timedelta(days=mais_antigos_que_dias)
    db().logs.delete_many({"ts": {"$lt": limite}})