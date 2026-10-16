"""
WORKER — roda no Railway 24h.

Responsabilidades:
  1. Manter a conexao com a corretora viva
  2. Funcao 1: pedir analise da IA e publicar a sugestao para aprovacao
  3. Funcao 2: executar os sinais da lista no horario
  4. Expor /health para o Railway saber que esta vivo

Executa IA e sinais em threads separadas para uma nunca travar a outra.
"""
import os
import threading
import time
from datetime import datetime, timedelta

import requests

import ai
import executor
import news
from broker import Broker, BrokerError
from settings import agora, db, get_config, registrar_log

SITE_URL = os.getenv("SITE_URL", "")  # URL do painel na Vercel (opcional)
VERBAO = "1.0.0"

_broker: Broker | None = None
_broker_lock = threading.Lock()
_rodando = threading.Event()
_sugestao_em_curso = threading.Event()
_lista_em_curso = threading.Event()


# ------------------------------------------------------------------ corretora


def obter_broker(cfg: dict) -> Broker | None:
    """Instancia unica do Broker. Reconecta se as credenciais/config mudarem."""
    global _broker
    with _broker_lock:
        conf = cfg.get("broker") or {}
        email = conf.get("email") or os.getenv("EXNOVA_EMAIL", "")
        senha = conf.get("password") or os.getenv("EXNOVA_PASS", "")
        tipo = conf.get("account_type") or "PRACTICE"

        if not email or not senha:
            return None

        if _broker and _broker.email == email and _broker.account_type == tipo and _broker.senha_ok(senha):
            return _broker

        if _broker:
            _broker.desconectar()
        try:
            _broker = Broker(email, senha, tipo)
        except BrokerError:
            _broker = None
        return _broker


# ------------------------------------------------------------------ Funcao 1: IA


def _publicar_sugestao(ativo, direcao, confianca, analise, cfg, origem_extra=None, contexto_noticias=""):
    """Grava a sugestao como PENDENTE. So entra em operacao se o usuario aprovar."""
    ai_cfg = cfg.get("ai") or {}
    exp = int((cfg.get("trade") or {}).get("expiration", 15))
    doc = {
        "created_at": agora(),
        "ativo": ativo.upper(),
        "direcao": direcao,
        "confianca": confianca,
        "analise": analise,
        "noticias": contexto_noticias,
        "expiracao": exp,
        "valor": (cfg.get("trade") or {}).get("amount", 10.0),
        "timeframes": ai_cfg.get("timeframes", ["M1", "M5", "M15"]),
        "status": "pendente",
        "origem_extra": origem_extra,
        "modelo": ai_cfg.get("model", ai.MODELO_PADRAO),
    }
    db().sugestoes.insert_one(doc)
    registrar_log(
        f"IA sugeriu {direcao} em {ativo.upper()} ({confianca}% conf) - aguardando aprovacao",
        "info", "ia",
    )
    return doc


def _expirar_sugestoes_pendentes(max_min: int = 20):
    """Sugestao nao aprovada em 20 min ja nao vale (o mercado ja mudou)."""
    limite = agora() - timedelta(minutes=max_min)
    db().sugestoes.update_many(
        {"status": "pendente", "created_at": {"$lt": limite}},
        {"$set": {"status": "expirada"}},
    )


def loop_ia():
    """Analisa com a IA no intervalo configurado e publica a sugestao."""
    while _rodando.is_set():
        try:
            cfg = get_config()
            ai_cfg = cfg.get("ai") or {}

            if not ai_cfg.get("enabled", True):
                time.sleep(10)
                continue

            intervalo = max(15, int(ai_cfg.get("interval_sec", 60)))
            broker = obter_broker(cfg)
            if not broker:
                time.sleep(30)
                continue

            ativo = (cfg.get("trade") or {}).get("active", "EURUSD-OTC")
            minutos = int((cfg.get("trade") or {}).get("expiration", 15))
            timeframes = ai_cfg.get("timeframes") or ["M1", "M5", "M15"]
            min_conf = int(ai_cfg.get("min_confidence", 70))

            # so analisa uma vez por ciclo de cada ativo
            if db().sugestoes.find_one(
                {"ativo": ativo.upper(), "created_at": {"$gte": agora() - timedelta(seconds=intervalo)}}
            ):
                time.sleep(5)
                continue

            _expirar_sugestoes_pendentes()

            velas_por_tf = {}
            for tf in timeframes:
                try:
                    velas_por_tf[tf] = broker.candles(ativo, tf, quantidade=60)
                except Exception as e:  # noqa: BLE001
                    registrar_log(f"Falha ao puxar {tf} de {ativo}: {e}", "erro", "ia")
                    velas_por_tf[tf] = []

            if not any(velas_por_tf.values()):
                time.sleep(intervalo)
                continue

            # pesquisa de noticias (cache de 5 min dentro do news.py)
            contexto = ""
            if ai_cfg.get("usar_noticias", True):
                try:
                    contexto = news.buscar_noticias(ativo, minutos)["resumo"]
                except Exception as e:  # noqa: BLE001
                    registrar_log(f"Falha ao buscar noticias: {e}", "aviso", "ia")
                    contexto = ""

            resultado = ai.analisar(
                ativo, minutos, velas_por_tf,
                ai_cfg.get("model", ai.MODELO_PADRAO),
                contexto_noticias=contexto,
            )
            _sugestao_em_curso.clear()

            if resultado.get("erro") or not resultado.get("direcao"):
                registrar_log(
                    f"IA sem operacao em {ativo.upper()}: {resultado.get('analise', '')[:200]}",
                    "aviso", "ia",
                )
                time.sleep(intervalo)
                continue

            if resultado["confianca"] < min_conf:
                registrar_log(
                    f"IA em {ativo.upper()}: {resultado['direcao']} com apenas "
                    f"{resultado['confianca']}% (minimo {min_conf}%) - descartada",
                    "info", "ia",
                )
                time.sleep(intervalo)
                continue

            _publicar_sugestao(ativo, resultado["direcao"], resultado["confianca"],
                               resultado["analise"], cfg,
                               contexto_noticias=contexto)
        except Exception as e:  # noqa: BLE001
            registrar_log(f"Loop IA erro: {e}", "erro", "worker")
            _sugestao_em_curso.clear()
            time.sleep(15)
            continue

        time.sleep(max(5, int((get_config().get("ai") or {}).get("interval_sec", 60))))


# ------------------------------------------------------------------ Funcao 2: sinais


def _segundos_ate(hora: str) -> int:
    """
    Segundos de HOJE ate a hora HH:MM.
    Negativo = ja passou. Retorna None se a hora nao for valida.
    """
    try:
        h, m = [int(x) for x in str(hora).strip().split(":")[:2]]
    except (ValueError, TypeError):
        return None
    if h > 23 or m > 59:
        return None
    alvo = datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    return int((alvo - datetime.now()).total_seconds())


def _executar_sinais_do_horario(cfg):
    """
    Le as listas ativas e dispara os sinais cuja hora chegou.
    Tolerancia de 90s: o worker checa a lista a cada 15s, entao o sinal
    pode ser detectado ate 90s depois da hora — antes disso ele espera.
    """
    broker = obter_broker(cfg)
    if not broker:
        return

    TOLERANCIA = 90  # segundos
    trade_cfg = cfg.get("trade") or {}
    auto = (cfg.get("sinais") or {}).get("auto_confirmar", False)

    for lote in db().listas.find({"status": "ativa"}).limit(5):
        lista = lote.get("sinais") or []
        pendentes = [s for s in lista if not s.get("executado") and not s.get("status") in ("executado", "erro", "aguardando")]
        if not pendentes:
            continue

        disparados = []
        for s in pendentes:
            faltam = _segundos_ate(s.get("time"))
            if faltam is None:
                disparados.append({**s, "status": "erro", "erro": f"hora invalida: {s.get('time')}"})
                continue
            # so age se a hora chegou (ou passou dentro da tolerancia)
            if faltam > 0 or abs(faltam) > TOLERANCIA:
                continue

            ativo = (s.get("active") or "").upper()
            direcao = (s.get("direcao") or "").upper()
            tf = (s.get("timeframe") or "M1").upper()

            if direcao not in ("CALL", "PUT"):
                disparados.append({**s, "status": "erro", "erro": f"direcao invalida: {direcao}"})
                continue

            if not broker.ativo_valido(ativo):
                disparados.append({**s, "status": "erro", "erro": f"ativo invalido: {ativo}"})
                registrar_log(f"Sinal ignorado: ativo {ativo} nao existe na corretora.", "aviso", "sinal")
                continue

            if auto:
                executor.abrir_operacao(broker, ativo, direcao,
                                        int(trade_cfg.get("expiration", 15)),
                                        trade_cfg, "sinal", lote["_id"])
                disparados.append({**s, "status": "executado", "executado": True, "executado_em": agora()})
            else:
                # vira sugestao para voce aprovar no painel
                doc = _publicar_sugestao(
                    ativo, direcao, 100,
                    f"Sinal da lista '{lote.get('nome', 'lista')}': {tf} {s.get('time')} {direcao}",
                    cfg, origem_extra={"tipo": "sinal", "lista_id": str(lote["_id"]), "timeframe": tf},
                )
                disparados.append({**s, "status": "aguardando", "sugestao_id": str(doc["_id"])})

        if disparados:
            # atualiza apenas os sinais disparados, preservando os demais
            por_chave = {(d.get("time"), d.get("active"), d.get("direction")): d for d in disparados}
            atualizados = []
            for s in lista:
                chave = (s.get("time"), s.get("active"), s.get("direction"))
                atualizados.append(por_chave.get(chave, s))
            db().listas.update_one({"_id": lote["_id"]}, {"$set": {"sinais": atualizados}})


def loop_sinais():
    """Checa a lista de sinais a cada 15 segundos."""
    while _rodando.is_set():
        try:
            cfg = get_config()
            if (cfg.get("sinais") or {}).get("enabled", False):
                _executar_sinais_do_horario(cfg)
        except Exception as e:  # noqa: BLE001
            registrar_log(f"Loop sinais erro: {e}", "erro", "worker")
        time.sleep(15)


# ------------------------------------------------------------------ aprovacoes


def loop_aprovacoes():
    """Executa as sugestoes que o usuario aprovou no painel."""
    while _rodando.is_set():
        try:
            cfg = get_config()
            broker = obter_broker(cfg)
            if not broker:
                time.sleep(20)
                continue

            aprovadas = list(db().sugestoes.find({"status": "aprovada"}).limit(5))
            for s in aprovadas:
                # marca como "executando" antes — evita rodar duas vezes
                achou = db().sugestoes.update_one(
                    {"_id": s["_id"], "status": "aprovada"},
                    {"$set": {"status": "executando", "aprovada_em": s.get("aprovada_em") or agora()}},
                )
                if achou.modified_count == 0:
                    continue  # outro ciclo pegou antes

                trade_cfg = cfg.get("trade") or {}
                trade = executor.abrir_operacao(
                    broker, s["ativo"], s["direcao"], int(s.get("expiracao", 15)),
                    trade_cfg, "ia", s["_id"],
                )
                db().sugestoes.update_one(
                    {"_id": s["_id"]},
                    {"$set": {"status": "executada", "order_id": trade.get("order_id"),
                              "executed_at": agora()}},
                )

                # acompanha resultado em thread separada
                threading.Thread(
                    target=executor.acompanhar_resultado,
                    args=(broker, {**trade, "_id": trade.get("_id")}),
                    daemon=True,
                ).start()
        except Exception as e:  # noqa: BLE001
            registrar_log(f"Loop aprovacoes erro: {e}", "erro", "worker")
        time.sleep(8)


# ------------------------------------------------------------------ heartbeat


def _heartbeat():
    """Avisa o painel que o worker esta vivo (painel mostra "ONLINE"/"OFFLINE")."""
    while _rodando.is_set():
        try:
            db().status.update_one(
                {"_id": "worker"},
                {"$set": {"online": True, "visto_em": agora()}},
                upsert=True,
            )
            if SITE_URL:
                try:
                    requests.post(f"{SITE_URL.rstrip('/')}/api/heartbeat", timeout=5)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        time.sleep(20)


def _rotina_diaria():
    """Limpeza periodica do banco."""
    while _rodando.is_set():
        time.sleep(3600)
        try:
            executor.limpar_antigos(30)
        except Exception:  # noqa: BLE001
            pass


# ------------------------------------------------------------------ health


def health():
    """Endpoint /health do worker (o Railway usa para saber que subiu)."""
    broker = _broker
    conectado = False
    if broker:
        try:
            conectado = bool(broker.api and broker.api.check_connect())
        except Exception:  # noqa: BLE001
            conectado = False
    return {
        "ok": True,
        "versao": VERSAO,
        "worker_online": _rodando.is_set(),
        "broker_conectado": conectado,
        "hora": agora().isoformat(),
    }


# ------------------------------------------------------------------ boot


def iniciar():
    registrar_log("Worker iniciado.", "info", "worker")
    _rodando.set()

    cfg = get_config()
    broker = obter_broker(cfg)
    if broker:
        try:
            registrar_log(f"Saldo: R$ {broker.saldo():.2f}", "info", "broker")
        except Exception:  # noqa: BLE001
            pass
    else:
        registrar_log("Corretora nao configurada — configure no painel.", "aviso", "worker")

    for alvo, nome in (
        (loop_ia, "ia"),
        (loop_sinais, "sinais"),
        (loop_aprovacoes, "aprovacoes"),
        (_heartbeat, "heartbeat"),
        (_rotina_diaria, "limpeza"),
    ):
        threading.Thread(target=alvo, name=nome, daemon=True).start()


def parar():
    _rodando.clear()
    if _broker:
        _broker.desconectar()


# ------------------------------------------------------------------ web (health)


from flask import Flask, jsonify, request  # noqa: E402  (import atrasado de proposito)

app = Flask(__name__)


@app.get("/health")
def _health():
    return jsonify(health())


@app.post("/chat")
def _chat():
    """Conversa com a IA. O painel repassa as mensagens aqui."""
    import chat as chat_mod

    corpo = request.get_json(silent=True) or {}
    mensagens = corpo.get("mensagens") or []

    if not mensagens:
        return jsonify({"erro": "Envie ao menos uma mensagem."}), 400

    cfg = get_config()
    ativo = (corpo.get("ativo") or (cfg.get("trade") or {}).get("active") or "EURUSD-OTC")
    minutos = int(corpo.get("minutos") or (cfg.get("trade") or {}).get("expiration", 15))

    broker = obter_broker(cfg)
    if not broker:
        return jsonify({
            "resposta": "Nao consigo falar agora: a corretora nao esta configurada. "
                        "Vou na aba Configuracao e coloque email e senha.",
            "erro": "sem_corretora",
        }), 200

    try:
        resultado = chat_mod.responder(broker, mensagens, ativo, minutos)
    except Exception as e:  # noqa: BLE001
        registrar_log(f"Erro no chat: {e}", "erro", "ia")
        return jsonify({"resposta": f"Falha no chat: {e}", "erro": str(e)}), 200

    # se a IAuinsistiu numa entrada, vira sugestao aprovavel
    if resultado.get("sugestao"):
        s = resultado["sugestao"]
        criada = chat_mod.registrar_sugestao_do_chat(
            s["ativo"], s["direcao"], s["confianca"], s["justificativa"]
        )
        resultado["sugestao_criada"] = criada
        registrar_log(
            f"IA sugeriu {s['direcao']} em {s['ativo']} via chat ({s['confianca']}%)",
            "info", "ia",
        )

    return jsonify(resultado)


@app.get("/velas")
def _velas():
    """Velas do ativo — o painel desenha o grafico."""
    cfg = get_config()
    ativo = (request.args.get("ativo") or (cfg.get("trade") or {}).get("active") or "EURUSD-OTC")
    timeframe = (request.args.get("tf") or "M1").upper()
    try:
        qtd = min(200, max(10, int(request.args.get("qtd", 60))))
    except (TypeError, ValueError):
        qtd = 60

    broker = obter_broker(cfg)
    if not broker:
        return jsonify({"erro": "corretora nao configurada", "velas": []}), 200

    try:
        velas = broker.candles(ativo, timeframe, quantidade=qtd)
    except Exception as e:  # noqa: BLE001
        return jsonify({"erro": str(e), "velas": []}), 200

    return jsonify({
        "ativo": ativo.upper(),
        "timeframe": timeframe,
        "velas": [{"t": v["t"], "dt": v["dt"], "o": v["o"], "h": v["h"], "l": v["l"], "c": v["c"]} for v in velas],
    })


@app.get("/precos")
def _precos():
    """Ultimo preco + variacao de varios ativos. Alimenta o grid de Cotações."""
    cfg = get_config()
    bruto = request.args.get("ativos") or ""
    if not bruto:
        bruto = "EURUSD-OTC,GBPUSD-OTC,USDJPY-OTC,AUDUSD-OTC,USDCHF-OTC,USDCAD-OTC"

    try:
        qtd = min(60, max(5, int(request.args.get("qtd", 20))))
    except (TypeError, ValueError):
        qtd = 20

    broker = obter_broker(cfg)
    if not broker:
        return jsonify({"erro": "corretora nao configurada", "precos": []}), 200

    resultado = []
    for ativo in [a.strip().upper() for a in bruto.split(",") if a.strip()][:12]:
        try:
            velas = broker.candles(ativo, "M1", quantidade=qtd)
            if not velas:
                resultado.append({"ativo": ativo, "erro": "sem velas"})
                continue
            ultimo = velas[-1]["c"]
            primeiro = velas[0]["c"]
            resultado.append({
                "ativo": ativo,
                "preco": ultimo,
                "variacao": round((ultimo - primeiro) / primeiro * 100, 3) if primeiro else 0,
                "velas": qtd,
            })
        except Exception as e:  # noqa: BLE001
            resultado.append({"ativo": ativo, "erro": str(e)})

    return jsonify({"precos": resultado, "ts": agora().isoformat()})


@app.get("/ativos")
def _ativos():
    """Lista de ativos de binaria disponiveis na corretora."""
    cfg = get_config()
    broker = obter_broker(cfg)
    if not broker:
        return jsonify({"erro": "corretora nao configurada", "ativos": []}), 200
    try:
        ativos = sorted((broker.ativos_binarios() or {}).keys())
    except Exception as e:  # noqa: BLE001
        return jsonify({"erro": str(e), "ativos": []}), 200
    return jsonify({"ativos": ativos, "total": len(ativos)})


# Sobe os loops ao importar o modulo — assim o gunicorn (Procfile) tambem funciona.
# no Railway roda com --workers 1, entao os loops sobem uma vez so.
iniciar()

if __name__ == "__main__":
    porta = int(os.getenv("PORT", "8080"))
    registrar_log(f"Servidor de health no porto {porta}", "info", "worker")
    app.run(host="0.0.0.0", port=porta, threaded=True)