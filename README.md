# 🤖 Binárias com IA

Reescrita do seu `BOTTELEGRAN` — agora com **painel web na Vercel** e **worker no Railway**.
Sem Telegram. Instalável como app.

## O que ele faz

**Função 1 — IA**
Lê as velas de M1, M5 e M15 + indicadores (RSI, EMA, Bollinger) + **notícias do mercado**,
e diz se o ativo sobe (CALL) ou desce (PUT) nos próximos minutos, com % de confiança.
**Nunca entra sozinha.** Publica a sugestão e espera você apertar ENTRAR.

**Função 2 — Lista de sinais**
Você cola a lista no painel. No horário de cada sinal, o robô age.
Se `auto_confirmar` estiver desligado (padrão), cada sinal vira uma sugestão para você aprovar.

**Bônus — Conversar com a IA**
Uma aba de chat onde o analista tem o contexto completo da operação: velas, notícias,
posição aberta, histórico e o que ele já disse antes. Ele explica o que está acontecendo,
por que não operou, qual o risco. Se sugerir uma entrada, vira sugestão aprovável.

## Abas do painel

Mesma estrutura do LEVERAGE ARB, com a mesma paleta e a mesma logo:

| Aba | O que faz |
|---|---|
| 📊 Cotações | Gráfico de preço + grade de vários ativos ao vivo |
| 🖥 Monitor | Estado do worker, IA, pendências, posições, resultado |
| 💰 Saldo | Resumo financeiro e últimas 20 operações |
| 🎯 Oportunidades | Sugestões da IA (aprovar/ignorar) + lista de sinais |
| 💬 Conversar com IA | Chat contextual sobre a operação |
| 🤖 Bot IA | Liga/desliga IA, timeframes, intervalo, martingale |
| 🧪 Conta Demo | Alterna DEMO ↔ REAL e credenciais |
| 📈 Analytics | Assertividade, resultado acumulado, acerto por ativo/direção |
| 📋 Histórico | Todas as operações com número da ordem |
| ⚙ Configuração | Modelo, chave OpenAI, timeframes |

## Instalar como app

O painel é PWA. No Chrome/Edge aparece o botão **⬇ Instalar app** no topo.
Instalado, ele abre em janela própria (sem barra de navegador), com ícone próprio e
funciona como aplicativo no Windows/Android/iPhone.

## Arquitetura

```
painel (Vercel)  ──Next.js──>  MongoDB  <──worker (Railway)── Exnova
   você opera                    ponto de encontro    a IA analisa e opera
```

A **Vercel não roda o robô** — funções serverless morrem em 60s. O painel é só interface.
Quem fica 24h conectado na corretora é o worker no Railway.

O painel conversa com o worker por HTTP (`WORKER_URL`): `/chat`, `/velas`, `/precos`, `/ativos`.

## Estrutura

```
worker/   -> Railway (Python)
  settings.py    Mongo + configuração
  broker.py      Exnova (conexão, velas, compra, resultado)
  news.py        RSS de notícias + filtro de relevância
  ai.py          indicadores + prompt + chamada OpenAI
  chat.py        conversa com contexto completo
  signals.py     parser da lista de sinais (texto ou JSON)
  executor.py    entrada, martingale, estatísticas
  main.py        os loops + endpoints HTTP

painel/   -> Vercel (Next.js)
  app/page.tsx     dashboard (10 abas)
  app/Logo.tsx     logo (mesma do LEVERAGE ARB)
  app/api/*        rotas
  public/          manifest, service worker, ícones
  lib/sinalParser.ts  parser de sinais (espelha signals.py)
```

## Deploy

### 1. MongoDB (obrigatório)

O cluster antigo (`cluster0.yaijahf`) **morreu** — Atlas free expira após 30 dias sem uso.
Crie um novo em [mongodb.com/atlas](https://www.mongodb.com/atlas/register):
plano Free, região São Paulo, *Network Access* liberado para `0.0.0.0/0`
(a Vercel e o Railway usam IP variável). Guarde a connection string.

### 2. Railway (worker)

```bash
cd worker
pip install -r requirements.txt
```

No Railway: **New Project → Deploy from GitHub Repo**, apontar pra `worker/`.
Variáveis:

| Variavel | Valor |
|---|---|
| `MONGO_URI` | sua string do MongoDB |
| `OPENAI_API_KEY` | `sk-...` |
| `EXNOVA_EMAIL` / `EXNOVA_PASS` | login da corretora |
| `EXNOVA_ACCOUNT` | `PRACTICE` (demo) ou `REAL` |

O Railway injeta `PORT` sozinho. O `Procfile` já sobe o gunicorn.
Teste depois: `https://seu-worker.up.railway.app/health`

### 3. Vercel (painel)

```bash
cd painel
npm install
npx vercel
```

Variáveis na Vercel:

| Variavel | Valor |
|---|---|
| `MONGO_URI` | a mesma do worker |
| `PANEL_PASSWORD` | sua senha de acesso |
| `PANEL_TOKEN` | string aleatória (cookie) |
| `WORKER_URL` | `https://seu-worker.up.railway.app` |
| `SITE_URL` | a URL do painel |

### 4. Rodar local

```bash
# terminal 1
cd worker && python main.py

# terminal 2
cd painel && npm run dev
```

## Testado nesta máquina

- 8 arquivos do worker compilam
- parser lê o `signals_379736318.json` antigo (5/5 sinais) e texto solto com bullet
- 7 fontes de notícia respondendo (ForexLive, CoinDesk, Investing BR, InfoMoney, ECB, BBC, CNBC)
- `npm run build` passa, 13 rotas de API
- ícones do app gerados (192/512/32)

## Depois: migrar para forex (XP Invest MT5)

A parte inteligente reaproveita inteira — `ai.py`, `news.py` (em M15/H1/H4) e `chat.py`.
Mudam só `broker.py` e `executor.py` (lote + SL/TP em vez de valor fixo + expiração).

O problema: `MetaTrader5` é **Windows-only**, não roda no Railway. Dois caminhos:

| Caminho | Custo | Como funciona |
|---|---|---|
| **API2Trade** | €12/mês (1 conta) | REST + WebSocket que faz ponte para XP MT4/MT5. Não precisa instalar MT5. Roda no Railway, mesma arquitetura. Ressalva: terceiro guarda suas credenciais de trading, TrustScore 4.0 no Trustpilot |
| **Windows VPS** | ~$10-30/mês | MT5 Python direto. Controle total, mas você gerencia o Windows e configura autostart |

## ⚠️ Antes de usar com dinheiro real

1. **Comece na conta demo.** Só troque para `REAL` com assertividade consistente.
2. **Martingale é a maior armadilha.** Com R$ 10 e multiplicador 2,2, 3 perdas seguidas = **R$ 80,40** de prejuízo.
3. **Binária não tem stop.** Decisão errada vira perda integral da operação.
4. **A IA erra.** Confiança de 85% ainda é palpite. Nenhuma previsão de 15 minutos é garantia.
5. **Rotacione as chaves do projeto antigo.** O `render.yaml` do BOTTELEGRAN tinha token do Telegram
   e senha do MongoDB em texto puro.