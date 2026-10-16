"""
Camada da corretora (Exnova / IQ Option) via exnovaapi.

Isola TODA a comunicacao com a plataforma num lugar so.
O resto do robo fala com este arquivo, nunca com a lib direto.

Assinaturas reais da lib (verificadas):
  Exnova(email, password, active_account_type='PRACTICE', proxies=None)
  .connect(sms_code=None)
  .get_candles(ACTIVES, interval, count, endtime)
  .buy(price, ACTIVES, ACTION, expirations)
  .check_win(id_number)
  .get_balance()
  .check_connect()
  .get_ALL_Binary_ACTIVES_OPCODE()
"""
import threading
import time
from datetime import datetime, timedelta

from exnovaapi.stable_api import Exnova

from settings import registrar_log

# timeframe aceito -> intervalo em minutos usado pela lib
INTERVALO_MIN = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
}


class BrokerError(Exception):
    """Erro de negocio da corretora (conta, permissao, ativo invalido)."""


class Broker:
    """
    Conexao com a corretora. Uma instancia por conta configurada.
    Reconecta sozinho: a lib cai com frequencia em OTC.
    """

    def __init__(self, email: str, password: str, account_type: str = "PRACTICE"):
        self.email = email
        self.password = password
        self.account_type = (account_type or "PRACTICE").upper()
        self.api = None
        self._lock = threading.Lock()
        self._ativos_cache = None
        self.conectar()

    # ------------------------------------------------------------ conexao

    def senha_ok(self, senha: str) -> bool:
        """Compara sem expor a senha (pra decidir se precisa reconectar)."""
        return self.password == senha

    def conectar(self) -> bool:
        with self._lock:
            try:
                tipo = "REAL" if self.account_type == "REAL" else "PRACTICE"
                self.api = Exnova(self.email, self.password, tipo)
                self.api.connect()
                self._ativos_cache = None
                registrar_log(f"Conectado na corretora ({tipo}).", "info", "broker")
                return True
            except Exception as e:  # noqa: BLE001 - log e propaga
                self.api = None
                registrar_log(f"Falha ao conectar: {e}", "erro", "broker")
                raise BrokerError(str(e)) from e

    def garantir_conectado(self, tentativas: int = 3) -> bool:
        """Verifica o socket e reconecta se caiu."""
        for tentativa in range(tentativas):
            if self.api is not None:
                try:
                    if self.api.check_connect():
                        return True
                except Exception:  # noqa: BLE001
                    pass
            try:
                self.conectar()
                return True
            except BrokerError:
                time.sleep(3 * (tentativa + 1))
        return False

    def saldo(self) -> float:
        self.garantir_conectado()
        try:
            return float(self.api.get_balance())
        except Exception as e:  # noqa: BLE001
            registrar_log(f"Erro ao ler saldo: {e}", "erro", "broker")
            return 0.0

    # ------------------------------------------------------------ ativos

    def ativos_binarios(self) -> dict:
        """Lista {nome: id} dos ativos de binária. Cacheado em memoria."""
        if self._ativos_cache is not None:
            return self._ativos_cache
        self.garantir_conectado()
        self._ativos_cache = self.api.get_ALL_Binary_ACTIVES_OPCODE() or {}
        return self._ativos_cache

    def ativo_valido(self, nome: str) -> bool:
        try:
            return nome.upper() in {k.upper() for k in self.ativos_binarios()}
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------ candles

    def candles(self, ativo: str, timeframe: str = "M1", quantidade: int = 60):
        """
        Retorna velas mais antigas -> mais novas:
        [{'t': epoch, 'o':, 'h':, 'l':, 'c':}, ...]
        """
        self.garantir_conectado()
        if timeframe not in INTERVALO_MIN:
            raise BrokerError(f"Timeframe invalido: {timeframe}")

        fim = int(time.time())
        bruto = self.api.get_candles(ativo.upper(), INTERVALO_MIN[timeframe], quantidade, fim)
        if not bruto:
            return []

        velas = []
        for c in reversed(bruto):  # a lib devolve do mais novo pro mais antigo
            t = c.get("time", c.get("t"))
            velas.append(
                {
                    "t": t,
                    "dt": datetime.fromtimestamp(t).strftime("%H:%M"),
                    "o": float(c["open"]),
                    "h": float(c["high"]),
                    "l": float(c["low"]),
                    "c": float(c["close"]),
                }
            )
        return velas

    # ------------------------------------------------------------ operacao

    def comprar(self, ativo: str, valor: float, direcao: str, expiracao_min: int):
        """
        Abre uma operacao de binaria.
        direcao: 'call' ou 'put'
        Retorna o order_id (int).
        """
        self.garantir_conectado()
        if not self.ativo_valido(ativo):
            raise BrokerError(f"Ativo invalido na corretora: {ativo}")
        if valor <= 0:
            raise BrokerError("Valor precisa ser maior que zero")
        if self.saldo() < valor:
            raise BrokerError(
                f"Saldo insuficiente (R$ {self.saldo():.2f} / precisa R$ {valor:.2f})"
            )

        acao = "call" if direcao.lower() == "call" else "put"
        try:
            pedido = self.api.buy(valor, ativo.upper(), acao, int(expiracao_min))
        except Exception as e:  # noqa: BLE001
            raise BrokerError(f"Ordem rejeitada: {e}") from e

        if not pedido or not pedido.get("id"):
            motivo = (pedido or {}).get("message", "motivo desconhecido")
            raise BrokerError(f"Ordem rejeitada: {motivo}")

        pedido["order_id"] = pedido["id"]
        pedido.pop("id", None)
        return pedido

    def resultado(self, order_id: int, expiracao_min: int):
        """
        Espera a expiracao e devolve o resultado.
        Retorna (status, lucro) com status em: 'ganho' | 'perdido' | None (aberto).
        """
        fim = time.time() + (expiracao_min * 60) + 120
        while time.time() < fim:
            time.sleep(5)
            self.garantir_conectado()
            try:
                r = self.api.check_win(int(order_id))
            except Exception:  # noqa: BLE001
                continue
            if r is None:
                continue
            lucro = float(r.get("profit", 0))
            status = "ganho" if lucro > 0 else "perdido"
            return status, lucro
        return None, 0.0

    def desconectar(self):
        with self._lock:
            try:
                if self.api:
                    self.api.logout()
            except Exception:  # noqa: BLE001
                pass
            self.api = None


def minutos_para_expiracao(timeframe: str) -> int:
    """M1->1, M5->5, M15->15 ... usado quando o usuario escolhe pelo timeframe."""
    return INTERVALO_MIN.get((timeframe or "M1").upper(), 1)


def tempo_restante_ate(hhmm: str):
    """Converte '15:42' em datetime de hoje. Devolve None se ja passou."""
    try:
        h, m = [int(x) for x in hhmm.strip().split(":")[:2]]
    except (ValueError, AttributeError):
        return None
    alvo = datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    if alvo < datetime.now():
        alvo += timedelta(days=1)
    return alvo