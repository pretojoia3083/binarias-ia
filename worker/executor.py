"""
Execucao de operacoes e controle de martingale.

Um unico caminho para abrir operacao, vinda da IA ou da lista de sinais.
Grava tudo na colecao "trades" e o painel mostra o historico.
"""
from datetime import timedelta

from bson import ObjectId

from settings import agora, db, registrar_log

MAX_STEPS_MART = 8  # teto de seguranca — nunca mais que isso em sequencia


def valor_da_operacao(valor_base: float, trade: dict) -> tuple:
    """
    Calcula o valor da proxima operacao aplicando martingale.

    Regra: apos uma PERDA seguida, multiplica o valor base.
    A sequencia zera no primeiro acerto.

    Retorna (valor, passo_atual).
    """
    martingale_on = bool(trade.get("martingale"))
    mult = float(trade.get("mart_mult") or 2.2)
    passos = int(trade.get("mart_steps") or 3)

    if not martingale_on:
        return float(valor_base), 0

    # conta a sequencia atual de perdas
    trades = (
        db()
        .trades.find({"status": {"$ne": "aberto"}}, {"_id": 0, "status": 1})
        .sort("created_at", -1)
        .limit(passos)
    )
    sequencia = 0
    for t in trades:
        if t.get("status") == "perdido":
            sequencia += 1
        else:
            break

    if sequencia <= 0 or sequencia > passos or sequencia >= MAX_STEPS_MART:
        return float(valor_base), 0

    passo = sequencia
    return round(float(valor_base) * (mult**passo), 2), passo


def abrir_operacao(broker, ativo: str, direcao: str, expiracao: int,
                   trade_cfg: dict, origem: str, referencia_id=None) -> dict:
    """
    Executa a entrada no libro de ofertas e registra na base.
    Retorna o documento do trade criado.
    """
    valor, passo = valor_da_operacao(trade_cfg.get("amount", 10.0), trade_cfg)
    if passo:
        registrar_log(f"Martingale passo {passo}: R$ {valor:.2f} em {ativo} {direcao}", "aviso", "trade")

    try:
        pedido = broker.comprar(ativo, valor, direcao, expiracao)
    except Exception as e:  # noqa: BLE001
        registrar_log(f"FALHA em {ativo} {direcao} R$ {valor:.2f}: {e}", "erro", "trade")
        doc = {
            "created_at": agora(), "origem": origem, "referencia_id": referencia_id,
            "ativo": ativo, "direcao": direcao, "valor": valor, "expiracao": expiracao,
            "status": "falhou", "lucro": 0.0, "motivo_erro": str(e),
            "martingale_passo": passo,
        }
        db().trades.insert_one(doc)
        return doc

    doc = {
        "created_at": agora(),
        "origem": origem,              # "ia" | "sinal"
        "referencia_id": referencia_id,
        "ativo": ativo,
        "direcao": direcao,
        "valor": valor,
        "expiracao": expiracao,
        "order_id": pedido.get("order_id"),
        "preco_entrada": pedido.get("price"),
        "status": "aberto",
        "lucro": 0.0,
        "martingale_passo": passo,
    }
    db().trades.insert_one(doc)
    doc["_id"] = doc["_id"] if "_id" in doc else ObjectId()

    registrar_log(
        f"ENTRADA {direcao} {ativo} R$ {valor:.2f} exp {expiracao}min "
        f"(ordem {doc['order_id']}, via {origem})",
        "info", "trade",
    )
    return doc


def acompanhar_resultado(broker, trade: dict):
    """
    Espera expirar, grava ganho/perdido e devolve o trade atualizado.
    Chamado em thread separada para nao travar o loop principal.
    """
    db_ = db()
    order_id = trade.get("order_id")
    if not order_id:
        return

    status, lucro = broker.resultado(order_id, int(trade.get("expiracao") or 15))
    if status is None:
        db_.trades.update_one(
            {"_id": trade["_id"]},
            {"$set": {"status": "indefinido", "lucro": 0.0, "finalizado_em": agora()}},
        )
        registrar_log(f"Trade {order_id} ficou sem resultado (expirou a consulta).", "aviso", "trade")
        return

    db_.trades.update_one(
        {"_id": trade["_id"]},
        {
            "$set": {
                "status": status,
                "lucro": lucro,
                "finalizado_em": agora(),
                "ganho_pct": round(lucro / trade["valor"] * 100, 2) if trade.get("valor") else 0,
            }
        },
    )

    emoji = "GANHO" if status == "ganho" else "PERDA"
    registrar_log(
        f"{emoji} {trade['ativo']} {trade['direcao']} -> R$ {lucro:+.2f} "
        f"({trade.get('order_id')})",
        "info" if status == "ganho" else "aviso", "trade",
    )


def estatisticas() -> dict:
    """Resumo do desempenho — mostrado no topo do painel."""
    pipeline = [
        {"$match": {"status": {"$in": ["ganho", "perdido"]}}},
        {
            "$group": {
                "_id": None,
                "total": {"$sum": 1},
                "ganhos": {"$sum": {"$cond": ["$eq", ["$status", "ganho"], 1, 0]}},
                "lucro_total": {"$sum": "$lucro"},
            }
        },
    ]
    r = next(iter(db().trades.aggregate(pipeline)), None) or {"total": 0, "ganhos": 0, "lucro_total": 0}
    total, ganhos = r["total"], r["ganhos"]
    return {
        "total": total,
        "ganhos": ganhos,
        "perdas": total - ganhos,
        "assertividade": round(ganhos / total * 100, 1) if total else 0.0,
        "lucro_total": round(r["lucro_total"], 2),
    }


def ultimo_resultado():
    """Resultado do ultimo trade finalizado — a martingale precisa dele."""
    return db().trades.find_one({"status": {"$in": ["ganho", "perdido"]}}, sort=[("finalizado_em", -1)])


def limpar_antigos(dias: int = 30):
    """Nao deixa o banco crescer para sempre."""
    limite = agora() - timedelta(days=dias)
    db().trades.delete_many({"created_at": {"$lt": limite}, "status": {"$ne": "aberto"}})