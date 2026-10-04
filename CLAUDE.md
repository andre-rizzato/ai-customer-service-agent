# CLAUDE.md

Orientações pra quem (humano ou Claude) for trabalhar neste repositório.

## Decisões de infraestrutura: sempre pelo trade-off custo/performance

Antes de propor ou escolher entre duas opções de infraestrutura (VM vs
container, processo único vs réplicas, vault compartilhado vs vault por
cliente, etc.), avalie explicitamente três eixos — não só "qual é mais
robusto":

1. **Overhead de recurso** — quanto CPU/RAM a opção consome *além* do
   trabalho útil. Numa VM pequena (hoje: `Standard_B1s`, 892MB RAM), isso
   não é teórico — já causou um incidente real (`npm ci` + 2 processos
   residentes travou a VM a ponto de não responder nem SSH, documentado em
   `docs/STATUS.md`).
2. **Custo Azure** — o que muda na fatura, não só "dá mais trabalho pra
   configurar". Muitas vezes duas opções têm custo igual (zero adicional)
   até um certo limiar de escala, e só divergem depois dele.
3. **Isolamento/blast radius** — o que acontece quando uma coisa dá
   errado: um cliente trava, isso derruba os outros? Vaza memória, afeta
   quem mais? Esse é um eixo de *confiabilidade*, não só de "elegância
   arquitetural" — trate como parte do trade-off de performance, não como
   extra.

Precedente já decidido (ver conversa de 04/10/2026, `docs/STATUS.md`):
**segundo cliente de teste roda como processo PM2 simples** (copiar
pasta + config própria + porta própria + bloco de Nginx), **não** como
container Docker — o overhead do Docker numa VM com <1GB de RAM pesa mais
do que vale, nesse estágio. Mitigação de isolamento sem pagar esse custo:
usar `max_memory_restart` do PM2 pra limitar o blast radius de um processo
vazando memória, em vez de migrar pra Docker só por isso. Reavaliar quando:
(a) a VM for maior, ou (b) o número de clientes tornar o compartilhamento
sem limite genuinamente arriscado — ver "Implantação multi-tenant" em
`docs/artifacts/mapa-capacidades.html` pro desenho completo com Docker +
User-Assigned Managed Identity + Key Vault por cliente, já pronto pra
quando isso fizer sentido.

## Outros documentos relevantes

- `docs/STATUS.md` — checklist consolidado do que está feito/pendente, nos três repositórios do projeto.
- `docs/GO_LIVE_CHECKLIST.md` — passos manuais de domínio/email/canais.
- `docs/artifacts/` — docs de arquitetura publicados (Blueprint do Agente, Mapa de Capacidades).
