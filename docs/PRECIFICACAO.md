# Precificação da Rizzato Tech — proposta de 09/10/2026

**Documento interno.** O bot nunca lê este arquivo. A tabela que os
clientes veem está em `knowledge/catalog.json`, o catálogo da própria
Rizzato Tech, usado no teste em produção. Aqui ficam as premissas e as
margens, para revisar quando houver dados reais de uso.

Os preços são uma **proposta**, montada com o custo medido em 09/10/2026.
Precisam da sua aprovação antes de ir ao ar, e de revisão depois de algumas
semanas de `npm run usage:report` com clientes reais.

## Tabela proposta

| | Essencial | Profissional | Completo |
|---|---|---|---|
| O que inclui | Atendimento | Atendimento + 1 capacidade (Agenda, Pedidos ou Vendas) | Atendimento + as 3 capacidades |
| Canais | 1 (WhatsApp ou Telegram) + chat do site | WhatsApp + Telegram + chat do site | idem |
| Mensalidade | R$ 349,00 | R$ 649,00 | R$ 1.190,00 |
| Franquia | 1.000 conversas/mês | 2.500 | 5.000 |
| Conversa excedente | R$ 0,25 | R$ 0,20 | R$ 0,15 |
| Implantação | R$ 990,00 | R$ 1.990,00 | R$ 3.490,00 |
| Anual (à vista, implantação grátis) | R$ 3.490,00 | R$ 6.490,00 | R$ 11.900,00 |
| Ajustes de catálogo/mês | 2 | 4 | 8 + prioridade |

- **Capacidade extra no Profissional:** R$ 300,00/mês.
- **Hora técnica:** R$ 150,00.
- **Implantação:**
  - 5% de desconto no Pix, ou 3x sem juros no cartão;
  - **ou** grátis com fidelidade de 12 meses;
  - **ou** grátis no plano anual.
- **Cancelamento e garantia:**
  - sem fidelidade para quem paga a implantação (aviso de 30 dias);
  - garantia de 30 dias com devolução de 50% da implantação.

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
| Essencial | R$ 349 | R$ 70 | R$ 86 | **~55%** |
| Profissional | R$ 649 | R$ 175 | R$ 86 | **~60%** |
| Completo | R$ 1.190 | R$ 350 | R$ 86 | **~63%** |

**Uso típico.** Um cliente costuma usar bem menos que a franquia, e a VM é
dividida entre vários clientes. Nesse caso, a margem passa de 75%. O
excedente custa de 2x a 3,5x o custo da conversa (R$ 0,15–0,25 contra R$
0,07), então uso alto nunca dá prejuízo.

**Implantação.** Ela paga o seu tempo de mapeamento a R$ 150/h:
- Essencial: ~6,5h;
- Profissional: ~13h;
- Completo: ~23h.

**Acessibilidade.** Três mecanismos tiram a barreira de entrada:
- **Implantação grátis com fidelidade:** para você, troca R$ 990 agora por
  pelo menos R$ 4.188 garantidos em 12 meses.
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

**Regra para editar o catálogo:** todo valor que o bot possa precisar
**calcular** precisa estar **escrito** no catálogo. Isso inclui total
anual, economia, parcela e exemplo de excedente. A checagem de valores
(`outputGuard.ts`) aceita direto só o preço com desconto do Pix e a parcela
"Nx de". O resto ela bloqueia, para proteger contra oferta falsa. Depois de
mudar o catálogo:
1. rode `npm run ingest`;
2. faça algumas perguntas de cálculo ao bot;
3. confira no audit log se apareceu alguma `system-note` "Checagem de
   valores".

## Como ativar em produção (com a VM ligada)

1. **Publicar o arquivo:** o push leva o `knowledge/catalog.json` junto. O
   deploy só não sobrescreve o `.env` e o `agent.config.json`.
2. **Ajustar o `agent.config.json` da VM** (pela tela via túnel SSH, ou à
   mão):
   - `"knowledgeBasePath": "./knowledge/catalog.json"`;
   - `"businessName": "Rizzato Tech"` (hoje está "Rizzato Systems", e o site
     usa "Rizzato Tech");
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
