# 📋 Status — o que está pronto e o que falta

Última atualização: 15/10/2026, madrugada.

---

## ✅ Já está pronto e testado

| Item | Situação |
|---|---|
| Código no GitHub | `pretojoia3083/binarias-ia` — commit `fe02bf3`, 44 arquivos |
| Painel (Vercel) | 10 abas, paleta e logo do LEVERAGE ARB, PWA instalável |
| Worker (Railway) | 8 arquivos Python, 4 endpoints HTTP (`/health`, `/chat`, `/velas`, `/precos`) |
| Função 1 — IA | Indicadores + 8 fontes de notícia + prompt. Só publica se passar da confiança mínima |
| Função 2 — Sinais | Parser lê texto solto (com bullet) e JSON. Testado: 4 de 5 linhas, ignorou o lixo |
| Chat com IA | Contexto completo: velas, notícias, posição aberta, histórico, memória |
| Notícias | 8 fontes respondendo. Filtro de relevância por moeda do ativo + termos macro |
| Build do painel | `npm run build` passa, 13 rotas |
| Segurança | Senha da corretora e chave OpenAI **não** voltam pro navegador (verificado) |
| Rodando local | MongoDB local + worker + painel em `http://localhost:3112` |

### Testes que passaram

```
login .................... ok
/api/config .............. ok  (worker online, segredos mascarados)
/api/sugestoes ........... ok  (aprovar funciona)
/api/trades .............. ok  (5 trades, 60% assertividade, R$ 6,30)
/api/sinais .............. ok  (criar lista com 4 sinais)
/api/logs ................ ok
parser de sinais ......... ok  (4 lidos, 1 ignorado)
notícias ................. ok  (33 relevantes para EURUSD-OTC)
```

### Bugs corrigidos durante os testes

- **Cookie de sessão não funcionava em HTTP local** — `secure: true` impedia o login no `localhost`
- **Worker não lia `.env`** — agora lê sem sobrescrever variáveis do Railway
- **Cluster do Atlas pausado em loop** —Agora o M0 aparece quando há projeto novo

---

## ❌ Falta fazer (2 coisas, ~15 min)

### 1. Criar o cluster no Atlas — VOCÊ PRECISA FAZER

**Por que eu parei:** a tela de criação tinha o **M30 a $0,77/hora (~$560/mês)** pré-selecionado.
Um clique errado cobra dinheiro real. Não quis arriscar de madrugada.

**O que aconteceu:** seu cluster antigo `leverage` **morreu e não volta**:

> *"This M0 cluster cannot be resumed because the MongoDB version of its backup
> snapshot is too old."*

**Plano do cluster novo (5 min):**

1. Atlas → **PROJECT** (canto superior) → **New Project**, nome `Binarias`
2. No projeto novo: **Clusters → Create** → agora **sim aparece o M0 Free**
3. Nome `binarias`, região **São Paulo**, resto padrão → **Create Deployment**
4. **Database & Network Access → Database Access → Add New User**
   - usuário `binariasbot`, senha: **crie uma nova** (a antiga era `pnKAFs...`, exposta no projeto antigo)
5. **Network Access → Add IP Address** → `0.0.0.0/0` → Confirm
6. **Connect → Drivers** → copie a string

> O cluster velho **não** foi apagado. Se os dados do LEVERAGE ARB importarem,
> fale com o suporte do Mongo para tentar resgate antes de terminar ele.

### 2. Criar chave da OpenAI — VOCÊ PRECISA FAZER

A chave do AdsFlow (`adsflow-saas/.env`) está **revogada** — retorna `401 invalid_api_key`.

1. [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → **Create new secret key**
2. Me mande, ou cole na aba **Configuração → Chave da OpenAI** do painel

---

## Depois dessas 2 coisas

**Testar local (recomendo antes de subir):**

```powershell
# 1. apontar o .env para o Atlas novo
#    worker\.env e painel\.env.local -> MONGO_URI=<sua string nova>

# 2. subir o worker
cd "C:\Users\Renato\Desktop\projetos code ia\binarias-ia\worker"
python main.py

# 3. em outro terminal
cd "..\painel"
npm run dev
```

**Subir:**

- **Railway**: New Project → GitHub Repo → `pretojoia3083/binarias-ia` → root `worker`
  - vars: `MONGO_URI`, `OPENAI_API_KEY`, `EXNOVA_EMAIL`, `EXNOVA_PASS`, `EXNOVA_ACCOUNT=PRACTICE`
- **Vercel**: `cd painel && npx vercel` → root `painel`
  - vars: `MONGO_URI`, `PANEL_PASSWORD`, `PANEL_TOKEN`, `WORKER_URL`, `SITE_URL`

---

## ⚠️ Antes de dinheiro real

1. **Conta DEMO primeiro.** Aba *Conta Demo* tem o botão.
2. **Martingale é cilada.** R$ 10 × 2,2 × 3 perdas = **R$ 80,40** de prejuízo.
3. **Binária não tem stop.**
4. **A IA vai errar.** 85% de confiança ainda é palpite.
5. **Troque a senha do MongoDB** — a do projeto antigo estava em texto puro no `render.yaml`.

---

## Decisão pendente: forex XP (M15/H1/H4)

`ai.py`, `news.py` e `chat.py` reaproveitam 100%. Mudam só `broker.py` e `executor.py`
(lote + SL/TP em vez de valor fixo + expiração).

| Caminho | Custo | Observação |
|---|---|---|
| **API2Trade** | €12/mês | REST/WebSocket pra XP MT4/MT5, roda no Railway. Terceiro guarda suas credenciais |
| **Windows VPS** | ~$15-30/mês | MT5 Python direto, controle total, mais trabalho de infra |

`MetaTrader5` é Windows-only — não roda no Railway.