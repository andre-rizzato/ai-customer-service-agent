# Precificação da Rizzato Tech — repreçficação de 13/10/2026

**Documento interno.** O bot nunca lê este arquivo. A tabela que os
clientes veem está em `knowledge/catalog.json`, o catálogo da própria
Rizzato Tech — **ainda com os valores antigos** (349/649/1.190); esta
revisão fica em proposta até você aprovar e rodar a seção "Como ativar em
produção" mais abaixo.

Os preços de 09/10/2026 (primeira versão deste documento) foram repreçados
em 13/10/2026 depois de uma pesquisa de mercado (concorrentes reais, não só
uma tabela genérica de "nível de projeto") — ver a seção "Por que
repreçar" abaixo pro raciocínio completo. Precisam da sua aprovação antes
de ir ao ar, e de revisão depois de algumas semanas de `npm run usage:report`
com clientes reais.

## Tabela proposta (13/10/2026)

| | Essencial | Profissional | Completo |
|---|---|---|---|
| O que inclui | Atendimento | Atendimento + 1 capacidade (Agenda, Pedidos ou Vendas) | Atendimento + as 3 capacidades |
| Canais | 1 (WhatsApp ou Telegram) + chat do site | WhatsApp + Telegram + chat do site | idem |
| Mensalidade | ~~R$ 349,00~~ **R$ 429,00** | ~~R$ 649,00~~ **R$ 890,00** | ~~R$ 1.190,00~~ **R$ 1.690,00** |
| Franquia | 1.000 conversas/mês | 2.500 | 5.000 |
| Conversa excedente | R$ 0,25 | R$ 0,20 | R$ 0,15 |
| Implantação | ~~R$ 990,00~~ **R$ 1.990,00** | ~~R$ 1.990,00~~ **R$ 3.790,00** | ~~R$ 3.490,00~~ **R$ 5.990,00** |
| Anual (à vista, implantação grátis) | ~~R$ 3.490,00~~ **R$ 4.290,00** | ~~R$ 6.490,00~~ **R$ 8.900,00** | ~~R$ 11.900,00~~ **R$ 16.900,00** |
| Ajustes de catálogo/mês | 2 | 4 | 8 + prioridade |

- **Capacidade extra no Profissional:** R$ 300,00/mês (sem mudança — já
  estava alinhada ao mercado, ver seção abaixo).
- **Hora técnica:** R$ 150,00 (sem mudança).
- **Implantação:**
  - 5% de desconto no Pix, ou 3x sem juros no cartão;
  - **ou** grátis com fidelidade de 12 meses;
  - **ou** grátis no plano anual.
- **Cancelamento e garantia:**
  - sem fidelidade para quem paga a implantação (aviso de 30 dias);
  - garantia de 30 dias com devolução de 50% da implantação.

## Por que repreçar (pesquisa de mercado, 13/10/2026)

Os preços de 09/10 foram montados só a partir do custo de API + infra —
nunca comparados contra o que o mercado de verdade cobra pelo mesmo nível
de tecnologia. A pesquisa (concorrentes brasileiros e internacionais)
achou um benchmark por **tipo de IA** (mais preciso que "nível de
projeto"):

| Categoria de IA | Mensalidade de mercado | Implantação de mercado |
|---|---|---|
| Bot de regras | R$ 0–150 | R$ 0–2.000 |
| IA conversacional sem RAG | R$ 150–800 | R$ 1.000–5.000 |
| **IA generativa com RAG de verdade** ← categoria deste produto | **R$ 200–2.000** | **R$ 2.000–10.000** |
| Enterprise personalizado | R$ 2.000–15.000 | R$ 10.000–100.000+ |

Comparado a concorrentes reais nessa categoria:
- **Zaia** (R$ 249/mês) e **GPT Maker** (R$ 147–497/mês): no-code, sem
  handoff humano real, sem RAG com reranking, sem integração de agenda —
  e cobravam perto do nosso Essencial antigo.
- **Zenvia** só libera IA generativa de verdade a partir do plano
  Specialist, **R$ 600/mês** — abaixo do que nosso Completo antigo (R$
  1.190) já entregava com 3 capacidades + 3 canais.
- **Zendesk AI** (R$ 755/agente/mês) e **Intercom Fin AI** (~R$ 5.300 pra
  1.000 resoluções/mês) são o teto internacional usado como referência por
  agências brasileiras.

**Diagnóstico:** a mensalidade de 09/10 já estava na faixa certa pra
categoria, só no piso baixo. A **implantação estava fora da faixa de
mercado** — R$ 990–3.490 contra um piso de R$ 2.000 pra "IA generativa com
RAG", a mesma categoria técnica dos concorrentes citados acima. O produto
entrega handoff humano com relay em tempo real, integração real de agenda
e camadas de segurança contra abuso que nenhum concorrente no-code citado
tem — a implantação precisava refletir isso.

## Por que esses números (vantajoso para você, acessível para o cliente)

**Custo por conversa**, medido em 09/10 com este catálogo:
- ~US$ 0,0033 por pergunta, incluindo HyDE, embedding, rerank e resposta;
- uma conversa real tem umas 3 a 4 perguntas: ~US$ 0,013, ou **~R$ 0,07**
  a R$ 5,40/US$.

**Infra:** a VM B1s com disco Premium e IP custa ~R$ 86/mês no total
(`CUSTO_AZURE.md`). Ela é dividida entre os clientes enquanto couber
(`CLAUDE.md`, "Decisões de infraestrutura").

**Margem bruta na franquia cheia**, o pior caso (um cliente pagando a VM
sozinho e usando 100% da franquia):

| | Receita | API (franquia × R$ 0,07) | Infra | Margem |
|---|---|---|---|---|
| Essencial | R$ 429 | R$ 70 | R$ 86 | **~64%** |
| Profissional | R$ 890 | R$ 175 | R$ 86 | **~71%** |
| Completo | R$ 1.690 | R$ 350 | R$ 86 | **~74%** |

**Uso típico.** Um cliente costuma usar bem menos que a franquia, e a VM é
dividida entre vários clientes. Nesse caso, a margem passa de 80%. O
excedente custa de 2x a 3,5x o custo da conversa (R$ 0,15–0,25 contra R$
0,07), então uso alto nunca dá prejuízo.

**Implantação.** Ela paga o seu tempo de mapeamento a R$ 150/h — os
números de 09/10 (6,5h/13h/23h) subestimavam o esforço real de entregar
RAG configurado, canais testados, segurança e (quando aplicável) a
capacidade extra funcionando de ponta a ponta. Horas revisadas pra bater
com o escopo de verdade:
- Essencial: ~13h;
- Profissional: ~25h;
- Completo: ~40h.

**Acessibilidade.** Três mecanismos tiram a barreira de entrada:
- **Implantação grátis com fidelidade:** para você, troca R$ 1.990 agora
  por pelo menos R$ 5.148 garantidos em 12 meses (Essencial).
- **Plano anual:** você recebe o ano adiantado.
- **Garantia de 30 dias:** o risco para você fica limitado a metade da
  implantação.

**Fora da conta:**
- **Impostos:** Simples Nacional sobre serviços, a confirmar com o contador.
- **Taxa da maquininha ou gateway no parcelado sem juros:** ~3–5%,
  absorvida por você.
- **Seu tempo de suporte.**
- As tarifas da Meta, o número de WhatsApp e as taxas do processador de
  pagamento ficam com o cliente. Isso está explícito no catálogo.

## Atenção antes de vender

- **Agenda e Vendas ainda não funcionam de ponta a ponta.** Hoje o
  `capabilityRouter` detecta essas perguntas, mas elas caem em atendimento
  humano (`STATUS.md`, "Técnico — capacidades"). O catálogo promete a
  integração "configurada e testada durante a implantação". Antes de fechar
  o primeiro Profissional ou Completo com essas capacidades, o conector
  precisa estar pronto.
- **Aviso de 80% da franquia e resumo mensal são manuais.** O catálogo
  promete os dois. Você faz isso com `npm run usage:report` na VM. A linha
  "Conversas cobráveis" é a que se compara com a franquia (definição:
  cliente × dia, no horário de Brasília, igual ao catálogo).
- **Pedidos de exclusão (LGPD)** são manuais, como o catálogo diz. Ver
  `SECURITY_REVIEW.md` #8 sobre retenção de dados.

## Como o catálogo foi testado

O teste foi feito no bot real, em ambiente isolado (Qdrant local, servidor
na porta 3999): 29 perguntas de potencial cliente, entre preço, parcela,
anual, excedente, cancelamento, WhatsApp, LGPD e inglês. O teste encontrou
e corrigiu cinco problemas do catálogo:

1. **"O WhatsApp está incluído no preço?" → "sim, sem custo adicional".**
   Era falso, porque as tarifas da Meta são do cliente. Agora cada plano diz
   isso, e o item de custos externos tem a pergunta no título.
2. **"O que vocês fazem?" → "não tenho os detalhes".** O título do item
   "Sobre" não casava com a pergunta curta.
3. **O bot calculava o total de 12 mensalidades e o valor do excedente.** A
   checagem de valores bloqueava, porque o número não estava no catálogo, e
   o cliente recebia a mensagem fixa. Agora esses valores estão escritos.
4. **"Clínicas estão entre nossos clientes"**, inventado a partir de
   "atendemos clínicas". Reescrito como "o agente é pensado para", com "não
   divulgamos nomes de clientes".
5. **Anual + fidelidade.** O bot combinava as duas regras por conta
   própria. A regra agora está explícita: no plano anual, a implantação é
   grátis.

Na rodada final, a checagem de valores não precisou bloquear nenhuma
resposta.

## Respostas de preço e encaminhamento comercial

Quando o cliente pergunta preço, o agente informa os valores publicados com
transparência e associa cada implantação ao plano correto. Não pode criar uma
faixa combinando o menor preço de um plano com o maior de outro; faixas só
passam pela checagem se estiverem declaradas no catálogo. Perguntas que pedem
comparação recebem mais trechos do RAG para que os três planos possam ser
apresentados juntos.

Se houver interesse, o agente pode oferecer — sem pressão e sem transferir
antes do aceite — que a equipe entenda o caso ou prepare uma proposta. Nos
canais em que a equipe já consegue responder na conversa, não se pede outro
contato. No chat do site, nome e um meio de contato só podem ser solicitados
quando a pessoa pedir retorno fora do chat, com explicação do uso e
consentimento.

**Regra para editar o catálogo:** todo valor que o bot possa precisar
**calcular** precisa estar **escrito** no catálogo. Isso inclui total
anual, economia, parcela e exemplo de excedente. A checagem de valores
(`outputGuard.ts`) aceita valores escritos no catálogo, descontos calculáveis
com percentuais autorizados e parcelas quando a resposta identifica o número
de parcelas. Também verifica associações entre nome do plano e preço e bloqueia
faixas não declaradas no catálogo. O resto ela bloqueia, para proteger contra
oferta falsa. Depois de mudar o catálogo:
1. rode `npm run ingest`;
2. faça algumas perguntas de cálculo ao bot;
3. confira no audit log se apareceu alguma `system-note` "Checagem de
   valores".

## Como ativar em produção (com a VM ligada)

**Nota (13/10/2026):** os passos 2 e 3 já tinham sido feitos pra versão de
09/10 — conferido direto na VM, `agent.config.json` já está com
`"businessName": "Rizzato Tech"` e `"knowledgeBasePath": "./knowledge/catalog.json"`.
O que falta pra esta repreçificação é só atualizar os VALORES dentro de
`knowledge/catalog.json` (passo 1) e reindexar (passo 3) — os passos 2 e 4
não precisam repetir.

1. **Publicar o arquivo:** o push leva o `knowledge/catalog.json` junto. O
   deploy só não sobrescreve o `.env` e o `agent.config.json`.
2. **Ajustar o `agent.config.json` da VM** (pela tela via túnel SSH, ou à
   mão) — já feito, confirmar que continua assim:
   - `"knowledgeBasePath": "./knowledge/catalog.json"`;
   - `"businessName": "Rizzato Tech"`;
   - tom de voz sugerido: `["cordial", "claro", "consultivo", "sem jargão técnico"]`
     (usado no teste).
3. **Indexar:** na VM, `cd ~/agente-atendimento && npm run ingest`. Isso
   substitui a coleção `catalog` do Qdrant de produção, que hoje tem o
   catálogo de exemplo dos filtros.
4. **Reiniciar:** `pm2 restart agente-atendimento --update-env`. Depois,
   pergunte pelo Telegram ou pelo widget "quanto custa o plano mais
   barato?".
5. **Eval de qualidade:** o `eval/` continua usando o catálogo de exemplo
   (`catalog.example.json`) num Qdrant local. Não aponte o eval para
   produção.
