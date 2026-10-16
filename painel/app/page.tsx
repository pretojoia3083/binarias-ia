"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";

/* evento que o Chrome/Edge dispara quando o app pode ser instalado */
type InstalarEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

/* ================================================================== tipos */

type Config = {
  broker: { email: string; password: string; account_type: string; temSenha?: boolean };
  trade: { active: string; amount: number; expiration: number; martingale: boolean; mart_mult: number; mart_steps: number };
  ai: {
    enabled: boolean; model: string; timeframes: string[]; interval_sec: number;
    min_confidence: number; usar_noticias: boolean; noticias_max: number;
  };
  sinais: { enabled: boolean; auto_confirmar: boolean };
};

type Sugestao = {
  id: string; criado_em: string; ativo: string; direcao: "CALL" | "PUT";
  confianca: number; analise: string; noticias: string; expiracao: number;
  valor: number; timeframes: string[]; status: string; origem_extra: any; order_id: number | null;
};

type Trade = {
  id: string; criado_em: string; finalizado_em: string | null; origem: string;
  ativo: string; direcao: string; valor: number; lucro: number; ganho_pct: number | null;
  expiracao: number; status: string; order_id: number | null; erro: string | null; martingale_passo: number;
};

type Log = { id: string; ts: string; nivel: string; origem: string; msg: string };

/* ================================================================== utils */

const VAZIO: Config = {
  broker: { email: "", password: "", account_type: "PRACTICE" },
  trade: { active: "EURUSD-OTC", amount: 10, expiration: 15, martingale: false, mart_mult: 2.2, mart_steps: 3 },
  ai: { enabled: true, model: "gpt-4o-mini", timeframes: ["M1", "M5", "M15"], interval_sec: 60, min_confidence: 70, usar_noticias: true, noticias_max: 8 },
  sinais: { enabled: false, auto_confirmar: false },
};

const ATIVOS = [
  "EURUSD-OTC", "GBPUSD-OTC", "USDJPY-OTC", "AUDUSD-OTC", "USDCHF-OTC",
  "USDCAD-OTC", "EURJPY-OTC", "EURGBP-OTC", "NZDUSD-OTC", "USDARS-OTC",
  "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "ETHUSD", "GOLD", "OIL",
];

const MODELOS = [
  "gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini",
];

const hhmm = (d: string) => new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const ddmma = (d: string) => new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const quando = (d: string) => {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `ha ${m}min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `ha ${h}h` : `${ddmma(d)} ${hhmm(d)}`;
};
const brl = (n: number) => `R$ ${Number(n || 0).toFixed(2)}`;
const sinal = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/** soma de N perdas seguidas na martingale */
function perdaTotal(base: number, mult: number, passos: number): number {
  const b = Number(base) || 0, m = Number(mult) || 1, n = Math.max(1, Number(passos) || 1);
  return Math.round(b * ((Math.pow(m, n) - 1) / (m - 1)) * 100) / 100;
}

/* ordem das abas — mesma logica do LEVERAGE ARB */
const ABAS = [
  { id: "cotacoes", nome: "📊 Cotações", icone: "" },
  { id: "monitor", nome: "🖥 Monitor", icone: "" },
  { id: "saldo", nome: "💰 Saldo", icone: "" },
  { id: "oportunidades", nome: "🎯 Oportunidades", icone: "" },
  { id: "chat", nome: "💬 Conversar com IA", icone: "" },
  { id: "bot", nome: "🤖 Bot IA", icone: "" },
  { id: "conta", nome: "🧪 Conta Demo", icone: "" },
  { id: "analytics", nome: "📈 Analytics", icone: "" },
  { id: "historico", nome: "📋 Histórico", icone: "" },
  { id: "configuracao", nome: "⚙ Configuração", icone: "" },
] as const;

/* ================================================================== app */

export default function Painel() {
  const [autenticado, setAutenticado] = useState<boolean | null>(null);
  const [senha, setSenha] = useState("");
  const [erroLogin, setErroLogin] = useState("");
  const [aba, setAba] = useState<string>("monitor");

  const [config, setConfig] = useState<Config>(VAZIO);
  const [workerOnline, setWorkerOnline] = useState(false);
  const [sugestoes, setSugestoes] = useState<Sugestao[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState({ total: 0, ganhos: 0, perdas: 0, assertividade: 0, lucro_total: 0 });
  const [logs, setLogs] = useState<Log[]>([]);
  const [toast, setToast] = useState<{ msg: string; tipo: "ok" | "erro" } | null>(null);
  const [podeInstalar, setPodeInstalar] = useState(false);
  const deferredPrompt = useRef<InstalarEvent | null>(null);

  // PWA: registra o service worker e escuta o evento de instalacao
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const aoPedir = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as InstalarEvent;
      setPodeInstalar(true);
    };
    window.addEventListener("beforeinstallprompt", aoPedir);
    return () => window.removeEventListener("beforeinstallprompt", aoPedir);
  }, []);

  async function instalar() {
    const p = deferredPrompt.current;
    if (!p) return;
    await p.prompt();
    await p.userChoice;
    deferredPrompt.current = null;
    setPodeInstalar(false);
  }

  // abre na aba pedida pelo atalho do PWA
  useEffect(() => {
    const alvo = new URLSearchParams(window.location.search).get("aba");
    if (alvo && ABAS.some((a) => a.id === alvo)) setAba(alvo);
  }, []);

  const avisar = useCallback((msg: string, tipo: "ok" | "erro" = "ok") => {
    setToast({ msg, tipo });
    setTimeout(() => setToast(null), 3400);
  }, []);

  useEffect(() => {
    fetch("/api/login").then((r) => r.json()).then((d) => setAutenticado(!!d.autenticado)).catch(() => setAutenticado(false));
  }, []);

  const carregar = useCallback(async () => {
    const [c, s, t, l] = await Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/sugestoes").then((r) => r.json()),
      fetch("/api/trades").then((r) => r.json()),
      fetch("/api/logs").then((r) => r.json()),
    ]);
    if (c?.config) setConfig(c.config);
    setWorkerOnline(!!c?.worker?.online);
    setSugestoes(s?.sugestoes || []);
    setTrades(t?.trades || []);
    if (t?.stats) setStats(t.stats);
    setLogs(l?.logs || []);
  }, []);

  useEffect(() => {
    if (!autenticado) return;
    carregar();
    const id = setInterval(carregar, 8000);
    return () => clearInterval(id);
  }, [autenticado, carregar]);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senha }),
    });
    if (r.ok) { setAutenticado(true); setErroLogin(""); }
    else setErroLogin("Senha incorreta.");
  }

  async function salvarConfig(parcial: any, msg = "Configuração salva.") {
    const r = await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parcial),
    });
    if (r.ok) { avisar(msg); carregar(); } else avisar("Falhou ao salvar", "erro");
  }

  if (autenticado === null) return <div className="login-wrap"><div className="login-card">Carregando…</div></div>;

  if (!autenticado) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={entrar}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <Logo tamanho={64} />
          </div>
          <h1 style={{ textAlign: "center" }}>Binárias com <span className="grad">IA</span></h1>
          <p style={{ textAlign: "center" }}>Painel de controle</p>
          {erroLogin && <div className="aviso perigo">{erroLogin}</div>}
          <div className="campo">
            <label>Senha</label>
            <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoFocus />
          </div>
          <button className="btn primario" style={{ width: "100%" }}>Entrar</button>
        </form>
      </div>
    );
  }

  const pendentes = sugestoes.filter((s) => s.status === "pendente").length;
  const contaReal = config.broker?.account_type === "REAL";

  return (
    <>
      <header className="topbar">
        <div className="brand" style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <Logo tamanho={34} />
          <span>Binárias com <span className="grad">IA</span></span>
        </div>
        <div className="topbar-right">
          <span className={`badge ${workerOnline ? "badge-green" : "badge-red"}`}>
            <i className="dot" /> Worker {workerOnline ? "ONLINE" : "OFFLINE"}
          </span>
          <span className={`badge ${config.ai?.enabled ? "badge-orange" : ""}`}>
            IA {config.ai?.enabled ? "LIGADA" : "DESLIGADA"}
          </span>
          <span className={`badge ${contaReal ? "badge-red" : "badge-green"}`}>
            {contaReal ? "CONTA REAL" : "DEMO"}
          </span>
          <span className="badge">{config.trade?.active} · {brl(config.trade?.amount)} · {config.trade?.expiration}min</span>
          {podeInstalar && (
            <button className="btn primario" onClick={instalar}>⬇ Instalar app</button>
          )}
          <button className="btn suave somente-web" onClick={() => setAutenticado(false)}>Sair</button>
        </div>
      </header>

      <nav className="tabs">
        {ABAS.map((a) => (
          <button
            key={a.id}
            className={`tab-btn ${aba === a.id ? "ativa" : ""}`}
            onClick={() => setAba(a.id)}
          >
            {a.nome}
            {a.id === "oportunidades" && pendentes > 0 && <span className="contador">{pendentes}</span>}
          </button>
        ))}
      </nav>

      <main className="content">
        {aba === "cotacoes" && <AbaCotacoes ativo={config.trade?.active} />}
        {aba === "monitor" && <AbaMonitor config={config} workerOnline={workerOnline} sugestoes={sugestoes} trades={trades} stats={stats} />}
        {aba === "saldo" && <AbaSaldo config={config} trades={trades} stats={stats} workerOnline={workerOnline} />}
        {aba === "oportunidades" && (
          <AbaOportunidades sugestoes={sugestoes} config={config} avisar={avisar} recarregar={carregar} irPara={setAba} />
        )}
        {aba === "chat" && <AbaChat config={config} recarregar={carregar} irPara={setAba} />}
        {aba === "bot" && <AbaBot config={config} setConfig={setConfig} salvar={salvarConfig} workerOnline={workerOnline} />}
        {aba === "conta" && <AbaConta config={config} setConfig={setConfig} salvar={salvarConfig} workerOnline={workerOnline} />}
        {aba === "analytics" && <AbaAnalytics trades={trades} stats={stats} sugestoes={sugestoes} />}
        {aba === "historico" && <AbaHistorico trades={trades} />}
        {aba === "configuracao" && <AbaConfig config={config} setConfig={setConfig} salvar={salvarConfig} avisar={avisar} />}
      </main>

      {toast && <div className={`toast ${toast.tipo}`}>{toast.msg}</div>}
    </>
  );
}

/* ================================================================== 1. COTAÇÕES */

function AbaCotacoes({ ativo }: { ativo?: string }) {
  const [precos, setPrecos] = useState<any[]>([]);
  const [erro, setErro] = useState("");
  const [lista, setLista] = useState<string>(
    ativo || "EURUSD-OTC,GBPUSD-OTC,USDJPY-OTC,AUDUSD-OTC,USDCHF-OTC,USDCAD-OTC"
  );

  const puxar = useCallback(() => {
    fetch(`/api/precos?ativos=${encodeURIComponent(lista)}&qtd=20`)
      .then((r) => r.json())
      .then((d) => {
        if (d.erro) setErro(d.erro);
        else { setErro(""); setPrecos(d.precos || []); }
      })
      .catch((e) => setErro(e.message));
  }, [lista]);

  useEffect(() => {
    puxar();
    const id = setInterval(puxar, 20000);
    return () => clearInterval(id);
  }, [puxar]);

  return (
    <>
      <GraficoPreco ativo={ativo} />

      <div className="card">
        <h2>📊 Grade de preços</h2>
        <p className="desc">Último preço e variação de cada ativo nos últimos 20 minutos. Atualiza a cada 20s.</p>

        <div className="campo">
          <label>Ativos para acompanhar (separados por vírgula)</label>
          <input value={lista} onChange={(e) => setLista(e.target.value)} />
        </div>

        {erro && <div className="aviso atencao">Não consegui puxar preços: {erro}</div>}

        <div className="grid3">
          {precos.map((p) => (
            <div key={p.ativo} className="preco-card">
              <div className="rotulo" style={{ color: "var(--muted)", fontSize: 11, marginBottom: 4 }}>{p.ativo}</div>
              {p.erro ? (
                <div className="d neg">{p.erro}</div>
              ) : (
                <>
                  <div className="n">{p.preco}</div>
                  <div className={`d ${p.variacao >= 0 ? "pos" : "neg"}`}>
                    {p.variacao >= 0 ? "▲ +" : "▼ "}{p.variacao?.toFixed(3)}%
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {!precos.length && !erro && <div className="vazio"><div className="g">📉</div><p>Carregando…</p></div>}
      </div>
    </>
  );
}

/* ================================================================== 2. MONITOR */

function AbaMonitor({ config, workerOnline, sugestoes, trades, stats }: any) {
  const pendentes = sugestoes.filter((s: Sugestao) => s.status === "pendente");
  const aberta = trades.filter((t: Trade) => t.status === "aberto");
  const ultimoLog = logs_resumo(logs_placeholder);

  return (
    <>
      <div className="card">
        <h2>🖥 Estado do sistema</h2>
        <p className="desc">Atualiza sozinho a cada 8 segundos.</p>
        <div className="status-grid">
          <div className="status-item">
            <span className="rotulo">Worker</span>
            <span className={`valor ${workerOnline ? "pos" : "neg"}`} style={{ fontSize: 17 }}>
              {workerOnline ? "ONLINE" : "OFFLINE"}
            </span>
            <span className="nota">{workerOnline ? "conectado na corretora" : "nada esta rodando"}</span>
          </div>
          <div className="status-item">
            <span className="rotulo">IA</span>
            <span className="valor" style={{ fontSize: 17 }}>{config.ai?.enabled ? "LIGADA" : "DESLIGADA"}</span>
            <span className="nota">a cada {config.ai?.interval_sec}s · mín {config.ai?.min_confidence}%</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Sugestões pendentes</span>
            <span className="valor" style={{ color: pendentes.length ? "var(--orange)" : undefined }}>{pendentes.length}</span>
            <span className="nota">esperando sua aprovação</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Posições abertas</span>
            <span className="valor" style={{ color: aberta.length ? "var(--blue)" : undefined }}>{aberta.length}</span>
            <span className="nota">{aberta.length ? aberta[0].ativo : "nenhuma agora"}</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Resultado</span>
            <span className={`valor ${stats.lucro_total >= 0 ? "pos" : "neg"}`}>{sinal(stats.lucro_total)}</span>
            <span className="nota">{stats.total} operações · {stats.assertividade}% acerto</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Valor por entrada</span>
            <span className="valor">{brl(config.trade?.amount)}</span>
            <span className="nota">expira em {config.trade?.expiration}min</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>🕐 Últimos eventos</h2>
        {sugestoes.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Quando</th><th>Origem</th><th>Ativo</th><th>Direção</th><th>Confiança</th><th>Status</th></tr></thead>
              <tbody>
                {sugestoes.slice(0, 10).map((s: Sugestao) => (
                  <tr key={s.id}>
                    <td>{quando(s.criado_em)}</td>
                    <td><span className={`tag ${s.origem_extra?.tipo === "sinal" ? "sinal" : s.origem_extra?.tipo === "chat" ? "chat" : ""}`}>
                      {s.origem_extra?.tipo || "ia"}
                    </span></td>
                    <td>{s.ativo}</td>
                    <td><span className={`dir ${s.direcao}`}>{s.direcao}</span></td>
                    <td>{s.confianca}%</td>
                    <td><span className={`tag ${s.status}`}>{s.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="desc">A IA ainda não deu nenhuma sugestão.</p>}
      </div>
    </>
  );
}

// helpers do monitor
const logs_placeholder: any[] = [];
function logs_resumo(l: any[]) { return l; }

/* ================================================================== 3. SALDO */

function AbaSaldo({ config, trades, stats, workerOnline }: any) {
  const fechados = trades.filter((t: Trade) => t.status === "ganho" || t.status === "perdido");
  const ganhos = fechados.filter((t: Trade) => t.lucro > 0);
  const perdas = fechados.filter((t: Trade) => t.lucro < 0);
  const melhor = fechados.length ? Math.max(...fechados.map((t: Trade) => t.lucro)) : 0;
  const pior = fechados.length ? Math.min(...fechados.map((t: Trade) => t.lucro)) : 0;

  return (
    <>
      <div className="card">
        <h2>💰 Resumo financeiro</h2>
        <p className="desc">
          O saldo exato da corretora aparece quando o worker está conectado — ele lê direto da conta.
        </p>
        <div className="status-grid">
          <div className="status-item">
            <span className="rotulo">Resultado acumulado</span>
            <span className={`valor ${stats.lucro_total >= 0 ? "pos" : "neg"}`}>{sinal(stats.lucro_total)}</span>
            <span className="nota">soma de todas as operações fechadas</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Em aberto</span>
            <span className="valor">{trades.filter((t: Trade) => t.status === "aberto").length}</span>
            <span className="nota">posições aguardando resultado</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Melhor operação</span>
            <span className="valor pos">{sinal(melhor)}</span>
            <span className="nota">{ganhos.length} acertos</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Pior operação</span>
            <span className="valor neg">{sinal(pior)}</span>
            <span className="nota">{perdas.length} perdas</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📋 Últimas 20 operações</h2>
        {!fechados.length ? <p className="desc">Nenhuma operação fechada ainda.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Horário</th><th>Ativo</th><th>Dir.</th><th>Valor</th><th>Resultado</th><th>Retorno</th></tr></thead>
              <tbody>
                {fechados.slice(0, 20).map((t: Trade) => (
                  <tr key={t.id}>
                    <td>{ddmma(t.criado_em)} {hhmm(t.criado_em)}</td>
                    <td>{t.ativo}</td>
                    <td><span className={`dir ${t.direcao}`}>{t.direcao}</span></td>
                    <td>{brl(t.valor)}</td>
                    <td className={t.lucro >= 0 ? "pos" : "neg"}>{sinal(t.lucro)}</td>
                    <td className={t.lucro >= 0 ? "pos" : "neg"}>{t.ganho_pct ?? "—"}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ================================================================== 4. OPORTUNIDADES */

function AbaOportunidades({ sugestoes, config, avisar, recarregar, irPara }: any) {
  const [abaLista, setAbaLista] = useState<"ia" | "sinais">("ia");

  async function decidir(id: string, acao: "aprovar" | "recusar") {
    const r = await fetch("/api/sugestoes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, acao }),
    });
    const d = await r.json();
    if (r.ok) {
      avisar(acao === "aprovar" ? "Aprovado! O worker vai entrar na operação." : "Sugestão recusada.");
      recarregar();
    } else avisar(d.erro || "Falhou", "erro");
  }

  return (
    <>
      <div className="tabs" style={{ position: "static", background: "transparent", padding: 0, marginBottom: 14, borderBottom: "none" }}>
        <button className={`tab-btn ${abaLista === "ia" ? "ativa" : ""}`} onClick={() => setAbaLista("ia")}>
          🧠 Sugestões da IA
        </button>
        <button className={`tab-btn ${abaLista === "sinais" ? "ativa" : ""}`} onClick={() => setAbaLista("sinais")}>
          📋 Lista de sinais
        </button>
      </div>

      {abaLista === "ia" ? (
        <SugestoesLista sugestoes={sugestoes} decidir={decidir} irPara={irPara} />
      ) : (
        <ColaSinais config={config} avisar={avisar} recarregar={recarregar} />
      )}
    </>
  );
}

function SugestoesLista({ sugestoes, decidir, irPara }: any) {
  if (!sugestoes.length) {
    return (
      <div className="card">
        <div className="vazio">
          <div className="g">🧠</div>
          <p>Nenhuma sugestão ainda.</p>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            A IA analisa no intervalo configurado e só publica quando a confiança passa do mínimo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {sugestoes.map((s: Sugestao) => {
        const cor = s.confianca >= 75 ? "var(--green)" : s.confianca >= 55 ? "var(--orange2)" : "var(--red)";
        const tipo = s.origem_extra?.tipo;
        return (
          <div key={s.id} className={`sug ${s.direcao === "CALL" ? "call" : "put"}`}>
            <div className="sug-topo">
              <div>
                <div className="sug-ativo">
                  {s.ativo}
                  <span className={`dir ${s.direcao}`}>{s.direcao}</span>
                  {tipo && <span className={`tag ${tipo === "sinal" ? "sinal" : "chat"}`}>
                    {tipo === "sinal" ? "da lista" : tipo === "chat" ? "do chat" : tipo}
                  </span>}
                </div>
                <div className="sug-meta">
                  {s.timeframes?.join(" + ")} · {brl(s.valor)} · exp {s.expiracao}min · {quando(s.criado_em)}
                </div>
              </div>
              <div className="conf-wrap">
                <div className="conf-barra"><i style={{ width: `${s.confianca}%`, background: cor }} /></div>
                {s.confianca}%
                <span className={`tag ${s.status}`}>{s.status}</span>
              </div>
            </div>

            {s.analise && <div className="sug-analise">{s.analise}</div>}

            {s.noticias && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                  📰 Notícias que a IA pesquisou
                </summary>
                <div className="sug-noticias">{s.noticias}</div>
              </details>
            )}

            {s.status === "pendente" && (
              <div className="acoes">
                <button className={`btn ${s.direcao === "CALL" ? "call" : "put"}`} onClick={() => decidir(s.id, "aprovar")}>
                  ✓ ENTRAR {s.direcao} — {brl(s.valor)}
                </button>
                <button className="btn" onClick={() => decidir(s.id, "recusar")}>✕ Ignorar</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function ColaSinais({ config, avisar, recarregar }: any) {
  const [texto, setTexto] = useState("");
  const [nome, setNome] = useState("");
  const [prev, setPrev] = useState<any>(null);
  const [listas, setListas] = useState<any[]>([]);
  const [salvando, setSalvando] = useState(false);
  const timer = useRef<any>(null);

  const recarregarListas = useCallback(() => {
    fetch("/api/sinais").then((r) => r.json()).then((d) => setListas(d.listas || []));
  }, []);

  useEffect(() => { recarregarListas(); }, [recarregarListas]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!texto.trim()) { setPrev(null); return; }
    timer.current = setTimeout(() => {
      fetch("/api/sinais/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto }),
      }).then((r) => r.json()).then(setPrev);
    }, 500);
  }, [texto]);

  async function salvar() {
    setSalvando(true);
    const r = await fetch("/api/sinais", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, texto }),
    });
    const d = await r.json();
    setSalvando(false);
    if (r.ok) {
      avisar(`Lista salva: ${d.lidos} sinais.`);
      setTexto(""); setNome(""); setPrev(null);
      recarregarListas(); recarregar();
    } else avisar(d.erro || "Falhou ao salvar", "erro");
  }

  async function excluir(id: string) {
    await fetch("/api/sinais", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    recarregarListas();
    avisar("Lista removida.");
  }

  async function alternarSinais(chave: "enabled" | "auto_confirmar", valor: boolean) {
    await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sinais: { [chave]: valor } }),
    });
    avisar("Preferência salva.");
    recarregar();
  }

  return (
    <>
      <div className="card">
        <h2>⚡ Como o robô reage à lista</h2>
        <div className="toggle">
          <input type="checkbox" id="sig-on" checked={config.sinais?.enabled ?? false}
            onChange={(e) => alternarSinais("enabled", e.target.checked)} />
          <label htmlFor="sig-on">Ler e executar a lista de sinais</label>
        </div>
        <div className="toggle">
          <input type="checkbox" id="sig-auto" checked={config.sinais?.auto_confirmar ?? false}
            onChange={(e) => alternarSinais("auto_confirmar", e.target.checked)} />
          <label htmlFor="sig-auto">Executar automaticamente (sem perguntar)</label>
        </div>

        {config.sinais?.enabled && !config.sinais?.auto_confirmar && (
          <div className="aviso atencao">
            Cada sinal vira uma <strong>sugestão</strong> no horário dele. Você aprova ou ignora. Modo mais seguro.
          </div>
        )}
        {config.sinais?.auto_confirmar && (
          <div className="aviso perigo">
            <strong>Automático ligado.</strong> O robô entra no horário do sinal sem pedir confirmação.
            Binária não tem stop — sinal errado é prejuízo direto.
          </div>
        )}
      </div>

      <div className="card">
        <h2>📋 Colar lista de sinais</h2>
        <p className="desc">Um sinal por linha. Também aceita JSON. Exemplo: <code>M1 USDARS-OTC 15:42 CALL</code></p>

        <div className="campo">
          <label>Nome da lista (opcional)</label>
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="ex: Sinais de hoje 15/10" />
        </div>

        <div className="campo">
          <label>Lista</label>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={`M1 USDARS-OTC 15:42 CALL
• M5 EURUSD-OTC 15:46 PUT
M15 GBPUSD-OTC 16:03 VENDA

ou JSON:
[{"timeframe":"M1","active":"USDARS-OTC","time":"15:42","direction":"CALL"}]`} />
        </div>

        {prev && (
          <div className={`aviso ${prev.erro ? "perigo" : prev.sinais.length ? "ok" : "atencao"}`}>
            {prev.erro ? (
              <><strong>Não deu para ler:</strong> <pre style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{prev.erro}</pre></>
            ) : (
              <><strong>{prev.sinais.length} sinal(is)</strong> reconhecido(s){prev.ignoradas > 0 && ` · ${prev.ignoradas} linha(s) ignorada(s)`}</>
            )}
          </div>
        )}

        {prev?.sinais.length ? (
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table>
              <thead><tr><th>Hora</th><th>Ativo</th><th>Direção</th><th>Tempo</th></tr></thead>
              <tbody>
                {prev.sinais.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>{s.time}</td><td>{s.active}</td>
                    <td><span className={`dir ${s.direction}`}>{s.direction}</span></td>
                    <td><span className="tag">{s.timeframe}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <button className="btn primario" disabled={salvando || !prev?.sinais.length} onClick={salvar}>
          {salvando ? "Salvando…" : `Salvar lista${prev?.sinais.length ? ` (${prev.sinais.length})` : ""}`}
        </button>
      </div>

      <div className="card">
        <h2>🗂 Listas salvas</h2>
        {!listas.length ? <p className="desc">Nenhuma lista ainda.</p> : listas.map((l) => (
          <div key={l.id} style={{ borderBottom: "1px solid var(--border)", padding: "11px 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <strong>{l.nome}</strong>
              <div className="sug-meta">{l.total} sinais · {l.executados} executados · {l.aguardando} aguardando · {quando(l.criado_em)}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="tag pendente">{l.status}</span>
              <button className="btn perigo" onClick={() => excluir(l.id)}>Excluir</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ================================================================== 5. CHAT */

type Msg = { role: "user" | "assistant"; content: string };
type SugChat = { id: string; ativo: string; direcao: "CALL" | "PUT"; confianca: number; expiracao: number; valor: number };

const PERGUNTAS = [
  "O que tá acontecendo agora?",
  "Por que você não operou ainda?",
  "Explica o último sinal",
  "Qual o risco agora?",
  "Vale a pena entrar agora?",
];

function AbaChat({ config, recarregar, irPara }: any) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [sugs, setSugs] = useState<SugChat[]>([]);
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => { fim.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, enviando]);

  async function enviar(textoEnviado?: string) {
    const pergunta = (textoEnviado ?? texto).trim();
    if (!pergunta || enviando) return;

    const novas: Msg[] = [...msgs, { role: "user", content: pergunta }];
    setMsgs(novas); setTexto(""); setEnviando(true);

    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensagens: novas, ativo: config.trade?.active, minutos: config.trade?.expiration }),
      });
      const d = await r.json();
      if (d.sugestao_criada) { setSugs((s) => [d.sugestao_criada, ...s]); recarregar(); }
      setMsgs((m) => [...m, { role: "assistant", content: d.resposta || "(sem resposta)" }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", content: `Erro: ${e?.message}` }]);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <GraficoPreco ativo={config.trade?.active} />

      <div className="chat-box">
        <div className="chat-topo">
          <div>
            <strong>💬 Conversar com o analista</strong>
            <div className="sug-meta">
              Ele vê as velas de {(config.ai?.timeframes || []).join(" + ")}, as notícias de agora,
              sua posição aberta e seu histórico. Não é chat genérico — está lendo a sua conta.
            </div>
          </div>
          {msgs.length > 0 && <button className="btn suave" onClick={() => { setMsgs([]); setSugs([]); }}>Limpar</button>}
        </div>

        <div className="chat-msgs">
          {!msgs.length && (
            <div className="msg sistema">
              Pergunte o que quiser sobre a operação.
              <br /><br />
              Se ele sugerir uma entrada, aparece aqui — e você ainda precisa aprovar na aba Oportunidades.
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role === "user" ? "eu" : "ia"}`}>
              <span className="assinatura">{m.role === "user" ? "Você" : "Analista"}</span>
              {m.content}
            </div>
          ))}

          {enviando && (
            <div className="msg ia">
              <span className="assinatura">Analista</span>
              <span className="pontinto" /><span className="pontinto" /><span className="pontinto" />
            </div>
          )}

          {sugs.map((s) => (
            <div key={s.id} className="chat-sugestao">
              <div className="t">📋 Sugestão criada: <span className={`dir ${s.direcao}`}>{s.direcao}</span> {s.ativo} · {s.confianca}%</div>
              <div className="j">{brl(s.valor)} · expiração {s.expiracao}min</div>
              <button className="btn" onClick={() => irPara("oportunidades")}>Ver em Oportunidades</button>
            </div>
          ))}

          <div ref={fim} />
        </div>

        <div className="chat-rapidas">
          {PERGUNTAS.map((p) => (
            <button key={p} className="chip" onClick={() => enviar(p)} disabled={enviando}>{p}</button>
          ))}
        </div>

        <form className="chat-entrada" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
          <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Pergunte sobre a operação…" disabled={enviando} />
          <button className="btn primario" disabled={enviando || !texto.trim()}>
            {enviando ? "…" : "Enviar"}
          </button>
        </form>
      </div>
    </>
  );
}

/* ================================================================== 6. BOT IA */

function AbaBot({ config, setConfig, salvar, workerOnline }: any) {
  const set = (caminho: string, valor: any) => {
    const c = JSON.parse(JSON.stringify(config));
    const partes = caminho.split(".");
    let alvo: any = c;
    for (let i = 0; i < partes.length - 1; i++) alvo = alvo[partes[i]];
    alvo[partes[partes.length - 1]] = valor;
    setConfig(c);
  };

  function toggleTF(tf: string) {
    const atual: string[] = config.ai.timeframes || [];
    const novo = atual.includes(tf) ? atual.filter((t: string) => t !== tf) : [...atual, tf];
    if (novo.length) set("ai.timeframes", novo);
  }

  const ai = config.ai || {};
  const t = config.trade || {};

  return (
    <>
      <div className="card">
        <h2>🤖 Controle do robô</h2>
        <p className="desc">Liga a IA e define como ela deve se comportar.</p>

        <div className="toggle">
          <input type="checkbox" id="ai-on" checked={ai.enabled ?? true} onChange={(e) => set("ai.enabled", e.target.checked)} />
          <label htmlFor="ai-on">IA ligada</label>
        </div>

        {!workerOnline && (
          <div className="aviso perigo">
            Worker <strong>offline</strong>. Ligou a IA mas ninguém está analisando — suba o worker no Railway.
          </div>
        )}

        <div className="grid3">
          <div className="campo">
            <label>Ativo analisado</label>
            <select value={t.active} onChange={(e) => set("trade.active", e.target.value)}>
              {ATIVOS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="campo">
            <label>Analisar a cada (segundos)</label>
            <input type="number" min="15" value={ai.interval_sec} onChange={(e) => set("ai.interval_sec", Number(e.target.value))} />
          </div>
          <div className="campo">
            <label>Confiança mínima</label>
            <input type="number" min="0" max="100" value={ai.min_confidence} onChange={(e) => set("ai.min_confidence", Number(e.target.value))} />
            <div className="ajuda">Abaixo disso a IA se cala.</div>
          </div>
        </div>

        <div className="campo">
          <label>Timeframes analisados (a IA combina os 3)</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["M1", "M5", "M15"].map((tf) => (
              <button key={tf} className={`btn ${ai.timeframes?.includes(tf) ? "primario" : "suave"}`} onClick={() => toggleTF(tf)}>{tf}</button>
            ))}
          </div>
          <div className="ajuda">M1 = agora · M5 e M15 = contexto. Manter os 3 dá a leitura mais confiável.</div>
        </div>

        <div className="toggle">
          <input type="checkbox" id="ai-not" checked={ai.usar_noticias ?? true} onChange={(e) => set("ai.usar_noticias", e.target.checked)} />
          <label htmlFor="ai-not">IA pesquisa notícias antes de opinar</label>
        </div>

        <button className="btn primario" onClick={() => salvar({ ai, trade: { active: t.active, expiration: t.expiration, amount: t.amount } }, "Bot salvo.")}>
          💾 Salvar bot
        </button>
      </div>

      <div className="card">
        <h2>⚙️ Parâmetros da operação</h2>
        <div className="grid3">
          <div className="campo">
            <label>Valor por entrada (R$)</label>
            <input type="number" step="0.5" min="1" value={t.amount} onChange={(e) => set("trade.amount", Number(e.target.value))} />
          </div>
          <div className="campo">
            <label>Expiração (minutos)</label>
            <input type="number" min="1" max="60" value={t.expiration} onChange={(e) => set("trade.expiration", Number(e.target.value))} />
            <div className="ajuda">15 = expira em 15 minutos</div>
          </div>
        </div>

        <div className="toggle">
          <input type="checkbox" id="mg-on" checked={t.martingale ?? false} onChange={(e) => set("trade.martingale", e.target.checked)} />
          <label htmlFor="mg-on">Martingale (aumenta valor após perda)</label>
        </div>

        {t.martingale && (
          <>
            <div className="aviso perigo">
              Martingale multiplica o valor a cada perda. Com valor alto você pode estourar a conta em poucas operações seguidas.
            </div>
            <div className="grid2">
              <div className="campo">
                <label>Multiplicador</label>
                <input type="number" step="0.1" value={t.mart_mult} onChange={(e) => set("trade.mart_mult", Number(e.target.value))} />
              </div>
              <div className="campo">
                <label>Máximo de passos</label>
                <input type="number" min="1" max="6" value={t.mart_steps} onChange={(e) => set("trade.mart_steps", Number(e.target.value))} />
              </div>
            </div>
            <div className="aviso atencao">
              {t.mart_steps} perdas seguidas somam <strong>{brl(perdaTotal(t.amount, t.mart_mult, t.mart_steps))}</strong> —
              e a última seria de <strong>{brl(t.amount * t.mart_mult ** (t.mart_steps - 1))}</strong>.
            </div>
          </>
        )}

        <button className="btn primario" onClick={() => salvar({ trade: t }, "Parâmetros salvos.")}>
          💾 Salvar parâmetros
        </button>
      </div>
    </>
  );
}

/* ================================================================== 7. CONTA DEMO */

function AbaConta({ config, setConfig, salvar, workerOnline }: any) {
  const real = config.broker?.account_type === "REAL";
  const broker = config.broker || {};

  return (
    <>
      <div className="card">
        <h2>🧪 Tipo de conta</h2>
        <p className="desc">Comece sempre na demo. Só troque para real com assertividade consistente.</p>

        <div className="status-grid" style={{ marginBottom: 16 }}>
          <div className="status-item">
            <span className="rotulo">Conta em uso</span>
            <span className={`valor ${real ? "neg" : "pos"}`} style={{ fontSize: 17 }}>
              {real ? "REAL" : "DEMO"}
            </span>
            <span className="nota">{real ? "dinheiro de verdade" : "sem risco"}</span>
          </div>
          <div className="status-item">
            <span className="rotulo">Worker</span>
            <span className={`valor ${workerOnline ? "pos" : "neg"}`} style={{ fontSize: 17 }}>
              {workerOnline ? "CONECTADO" : "OFFLINE"}
            </span>
            <span className="nota">{workerOnline ? "conta ativa" : "rode o worker"}</span>
          </div>
        </div>

        <div className="toggle">
          <input type="checkbox" id="conta-real" checked={real}
            onChange={(e) => {
              const novo = { ...config, broker: { ...config.broker, account_type: e.target.checked ? "REAL" : "PRACTICE" } };
              setConfig(novo);
              salvar({ broker: { account_type: novo.broker.account_type } }, e.target.checked ? "⚠️ Agora é conta REAL." : "Voltou para DEMO.");
            }} />
          <label htmlFor="conta-real">Usar conta REAL (dinheiro de verdade)</label>
        </div>

        {real && (
          <div className="aviso perigo">
            <strong>Cuidado.</strong> Toda operação aprovada vai usar seu dinheiro. Binária não tem stop.
            Sugestão: rode pelo menos 50 operações na demo com assertividade acima de 60% antes de trocar.
          </div>
        )}
      </div>

      <div className="card">
        <h2>🔑 Acesso à corretora</h2>
        <div className="grid2">
          <div className="campo">
            <label>Email</label>
            <input value={broker.email || ""} onChange={(e) => setConfig({ ...config, broker: { ...config.broker, email: e.target.value } })} placeholder="seu@email.com" />
          </div>
          <div className="campo">
            <label>Senha</label>
            <input type="password" value={broker.password || ""}
              onChange={(e) => setConfig({ ...config, broker: { ...config.broker, password: e.target.value } })}
              placeholder={broker.temSenha ? "•••••• (já salva — vazio mantém)" : "sua senha"} />
          </div>
        </div>
        <button className="btn primario"
          onClick={() => salvar({ broker: { email: broker.email, password: broker.password, account_type: broker.account_type } }, "Credenciais salvas.")}>
          💾 Salvar acesso
        </button>
        <div className="ajuda" style={{ marginTop: 8 }}>
          A senha fica só no Mongo e é lida pelo worker. Nunca é devolvida ao navegador.
        </div>
      </div>
    </>
  );
}

/* ================================================================== 8. ANALYTICS */

function AbaAnalytics({ trades, stats, sugestoes }: any) {
  const fechados = trades.filter((t: Trade) => t.status === "ganho" || t.status === "perdido");
  const porAtivo = new Map<string, { g: number; p: number }>();
  const porDirecao = { CALL: { g: 0, p: 0 }, PUT: { g: 0, p: 0 } };

  for (const t of fechados as Trade[]) {
    const a = porAtivo.get(t.ativo) || { g: 0, p: 0 };
    if (t.lucro > 0) a.g++; else a.p++;
    porAtivo.set(t.ativo, a);
    if (porDirecao[t.direcao as "CALL" | "PUT"]) {
      if (t.lucro > 0) porDirecao[t.direcao as "CALL" | "PUT"].g++;
      else porDirecao[t.direcao as "CALL" | "PUT"].p++;
    }
  }

  // evolução acumulada
  let acc = 0;
  const pontos = [...fechados].reverse().map((t: Trade) => (acc += t.lucro, acc));

  const confAprovadas = sugestoes.filter((s: Sugestao) => ["aprovada", "executada", "ganho", "perdido"].includes(s.status));
  const confRecusadas = sugestoes.filter((s: Sugestao) => s.status === "recusada");

  return (
    <>
      <div className="card">
        <h2>📈 Desempenho</h2>
        <div className="status-grid">
          <div className="status-item"><span className="rotulo">Operações</span><span className="valor">{stats.total}</span></div>
          <div className="status-item"><span className="rotulo">Acertos</span><span className="valor pos">{stats.ganhos}</span><span className="nota">{stats.perdas} perdas</span></div>
          <div className="status-item"><span className="rotulo">Assertividade</span><span className="valor">{stats.assertividade}%</span></div>
          <div className="status-item"><span className="rotulo">Resultado</span><span className={`valor ${stats.lucro_total >= 0 ? "pos" : "neg"}`}>{sinal(stats.lucro_total)}</span></div>
        </div>
      </div>

      {pontos.length > 1 && <GraficoEvolucao pontos={pontos} />}

      <div className="card">
        <h2>📊 Por ativo</h2>
        {!porAtivo.size ? <p className="desc">Sem operações ainda.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ativo</th><th>Acertos</th><th>Perdas</th><th>Assertividade</th></tr></thead>
              <tbody>
                {[...porAtivo.entries()].sort((a, b) => b[1].g + b[1].p - (a[1].g + a[1].p)).map(([ativo, v]) => {
                  const tot = v.g + v.p;
                  const pct = Math.round((v.g / tot) * 100);
                  return (
                    <tr key={ativo}>
                      <td>{ativo}</td><td className="pos">{v.g}</td><td className="neg">{v.p}</td>
                      <td className={pct >= 55 ? "pos" : "neg"}>{pct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>↔️ Acerto por direção</h2>
        <div className="grid2">
          {(["CALL", "PUT"] as const).map((d) => {
            const v = porDirecao[d];
            const tot = v.g + v.p;
            const pct = tot ? Math.round((v.g / tot) * 100) : 0;
            return (
              <div key={d} className="status-item">
                <span className="rotulo">{d}</span>
                <span className={`valor ${pct >= 55 ? "pos" : "neg"}`}>{pct}%</span>
                <span className="nota">{v.g} acertos de {tot} operações</span>
              </div>
            );
          })}
        </div>
        <p className="desc" style={{ marginTop: 12, marginBottom: 0 }}>
          Se uma direção acerta muito mais que a outra, ajuste a confiança mínima ou deixe a IA calar mais.
        </p>
      </div>

      <div className="card">
        <h2>🧠 Suas decisões</h2>
        <p className="desc">
          Você aprovou {confAprovadas.length} sugestões e recusou {confRecusadas.length}.
          Se as suas aprovaçõesprofits mais do que as recusas, a IA está calibrada com o seu criterio.
        </p>
        <p className="desc" style={{ marginBottom: 0 }}>
          Aprovadas: {confAprovadas.length} · Recusadas: {confRecusadas.length}
        </p>
      </div>
    </>
  );
}

function GraficoEvolucao({ pontos }: { pontos: number[] }) {
  const W = 1000, H = 160, pad = 8;
  const min = Math.min(...pontos, 0), max = Math.max(...pontos, 0);
  const px = (i: number) => pad + (i / (pontos.length - 1)) * (W - pad * 2);
  const py = (v: number) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
  const linha = pontos.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const zero = py(0);
  const fim = pontos[pontos.length - 1];
  const cor = fim >= 0 ? "var(--green)" : "var(--red)";

  return (
    <div className="card">
      <h2>📉 Resultado acumulado</h2>
      <div className="grafico-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          <line x1={pad} y1={zero} x2={W - pad} y2={zero} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
          <path d={linha} fill="none" stroke={cor} strokeWidth="2" />
        </svg>
      </div>
    </div>
  );
}

/* ================================================================== 9. HISTÓRICO */

function AbaHistorico({ trades }: { trades: Trade[] }) {
  return (
    <div className="card">
      <h2>📋 Todas as operações</h2>
      {!trades.length ? (
        <div className="vazio"><div className="g">📊</div><p>Nenhuma operação registrada.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Horário</th><th>Origem</th><th>Ativo</th><th>Dir.</th><th>Valor</th><th>Exp.</th><th>Status</th><th>Resultado</th><th>Ordem</th></tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{ddmma(t.criado_em)} {hhmm(t.criado_em)}</td>
                  <td><span className={`tag ${t.origem === "sinal" ? "sinal" : ""}`}>{t.origem}</span></td>
                  <td>
                    {t.ativo}
                    {t.martingale_passo > 0 && <span className="tag" style={{ marginLeft: 5 }}>MG{t.martingale_passo}</span>}
                  </td>
                  <td><span className={`dir ${t.direcao}`}>{t.direcao}</span></td>
                  <td>{brl(t.valor)}</td>
                  <td>{t.expiracao}min</td>
                  <td><span className={`tag ${t.status}`}>{t.status}</span></td>
                  <td className={t.lucro > 0 ? "pos" : t.lucro < 0 ? "neg" : ""}>
                    {t.status === "falhou" ? t.erro : sinal(t.lucro)}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: 11 }}>{t.order_id ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================== 10. CONFIGURAÇÃO */

function AbaConfig({ config, setConfig, salvar, avisar }: any) {
  const [chave, setChave] = useState("");
  const set = (caminho: string, valor: any) => {
    const c = JSON.parse(JSON.stringify(config));
    const partes = caminho.split(".");
    let alvo: any = c;
    for (let i = 0; i < partes.length - 1; i++) alvo = alvo[partes[i]];
    alvo[partes[partes.length - 1]] = valor;
    setConfig(c);
  };

  function toggleTF(tf: string) {
    const atual = config.ai.timeframes;
    const novo = atual.includes(tf) ? atual.filter((t: string) => t !== tf) : [...atual, tf];
    if (novo.length) set("ai.timeframes", novo);
  }

  const ai = config.ai || {};

  return (
    <>
      <div className="card">
        <h2>🧠 Modelo de IA</h2>
        <p className="desc">Qual modelo responde. Modelos maiores entendem melhor, mas custam mais.</p>

        <div className="campo">
          <label>Modelo</label>
          <select value={ai.model} onChange={(e) => set("ai.model", e.target.value)}>
            {MODELOS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="ajuda">
            gpt-4o-mini é o melhor custo-benefício. gpt-4o / gpt-4.1 entendem mais contexto de notícia, mas custam ~5x mais.
          </div>
        </div>

        <div className="campo">
          <label>Chave da OpenAI</label>
          <input type="password" value={chave} onChange={(e) => setChave(e.target.value)} placeholder="sk-..." autoComplete="off" />
          <div className="ajuda">Fica guardada no worker (nunca no navegador). Deixe vazio se já configurou no Railway.</div>
          <button className="btn" style={{ marginTop: 8 }} disabled={!chave.trim()}
            onClick={async () => {
              const r = await fetch("/api/config", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ openai_key: chave.trim() }),
              });
              if (r.ok) { avisar("Chave enviada ao worker."); setChave(""); }
              else avisar("Falhou", "erro");
            }}>Enviar chave</button>
        </div>

        <div className="campo">
          <label>Timeframes analisados</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["M1", "M5", "M15"].map((tf) => (
              <button key={tf} className={`btn ${ai.timeframes?.includes(tf) ? "primario" : "suave"}`} onClick={() => toggleTF(tf)}>{tf}</button>
            ))}
          </div>
        </div>

        <div className="grid3">
          <div className="campo">
            <label>Notícias por análise</label>
            <input type="number" min="0" max="20" value={ai.noticias_max ?? 8} onChange={(e) => set("ai.noticias_max", Number(e.target.value))} />
          </div>
          <div className="campo">
            <label>Confiança mínima</label>
            <input type="number" min="0" max="100" value={ai.min_confidence ?? 70} onChange={(e) => set("ai.min_confidence", Number(e.target.value))} />
          </div>
          <div className="campo">
            <label>Intervalo (segundos)</label>
            <input type="number" min="15" value={ai.interval_sec ?? 60} onChange={(e) => set("ai.interval_sec", Number(e.target.value))} />
          </div>
        </div>

        <div className="toggle">
          <input type="checkbox" id="cfg-not" checked={ai.usar_noticias ?? true} onChange={(e) => set("ai.usar_noticias", e.target.checked)} />
          <label htmlFor="cfg-not">Pesquisar notícias antes de opinar</label>
        </div>

        <button className="btn primario" onClick={() => salvar({ ai }, "Configuração da IA salva.")}>💾 Salvar IA</button>
      </div>

      <div className="card">
        <h2>ℹ️ Sobre este sistema</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><td><strong>Função 1</strong></td><td>IA analisa M1/M5/M15 + notícias e sugere entrada. Você aprova.</td></tr>
              <tr><td><strong>Função 2</strong></td><td>Lista de sinais colada no painel, executada no horário de cada sinal.</td></tr>
              <tr><td><strong>Chat</strong></td><td>Converse com o analista sobre a operação a qualquer momento.</td></tr>
              <tr><td><strong>Risco</strong></td><td>Binária não tem stop loss. Comece na demo.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ================================================================== gráfico de preço */

function GraficoPreco({ ativo }: { ativo?: string }) {
  const [velas, setVelas] = useState<any[]>([]);
  const [tf, setTf] = useState("M1");
  const [erro, setErro] = useState("");

  useEffect(() => {
    let cancelado = false;
    const puxar = async () => {
      const r = await fetch(`/api/velas?ativo=${encodeURIComponent(ativo || "")}&tf=${tf}&qtd=60`).then((x) => x.json());
      if (cancelado) return;
      if (r.erro) setErro(r.erro); else { setErro(""); setVelas(r.velas || []); }
    };
    puxar();
    const id = setInterval(puxar, 20000);
    return () => { cancelado = true; clearInterval(id); };
  }, [ativo, tf]);

  if (!velas.length) {
    return (
      <div className="card">
        <h2>📈 {ativo || "—"}</h2>
        <p className="desc">{erro ? `Gráfico indisponível: ${erro}` : "Carregando velas da corretora…"}</p>
      </div>
    );
  }

  const fech = velas.map((v) => v.c);
  const min = Math.min(...fech), max = Math.max(...fech);
  const primeiro = fech[0], ultimo = fech[fech.length - 1];
  const variacao = ((ultimo - primeiro) / primeiro) * 100;
  const sobe = ultimo >= primeiro;

  const W = 1000, H = 175, pad = 7;
  const px = (i: number) => pad + (i / (velas.length - 1)) * (W - pad * 2);
  const py = (v: number) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 2);
  const linha = fech.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const area = `${linha} L${px(fech.length - 1).toFixed(1)},${H} L${px(0).toFixed(1)},${H} Z`;
  const cor = sobe ? "var(--green)" : "var(--red)";

  return (
    <div className="card">
      <div className="grafico-topo">
        <div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>{ativo} · {tf}</div>
          <div className="preco-atual" style={{ color: cor }}>{ultimo}</div>
          <div className={`variacao ${sobe ? "pos" : "neg"}`}>
            {sobe ? "▲ +" : "▼ "}{variacao.toFixed(3)}% no período
          </div>
        </div>
        <div className="tf-botoes">
          {["M1", "M5", "M15"].map((t) => (
            <button key={t} className={`tf-btn ${tf === t ? "ativa" : ""}`} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
      </div>

      <div className="grafico-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={sobe ? "#10B981" : "#EF4444"} stopOpacity="0.28" />
              <stop offset="100%" stopColor={sobe ? "#10B981" : "#EF4444"} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#grad)" />
          <path d={linha} fill="none" stroke={cor} strokeWidth="2" />
        </svg>
      </div>
      <div className="sug-meta" style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span>{velas[0]?.dt}</span><span>{velas[velas.length - 1]?.dt}</span>
      </div>
    </div>
  );
}