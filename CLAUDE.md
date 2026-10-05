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

## Toda chave SSH gerada no Windows precisa de ACL restrita manualmente

`ssh-keygen` no Git Bash (Windows) **não** aplica uma permissão equivalente
ao `chmod 600` do Linux — o arquivo da chave privada sai com a ACL herdada
da pasta, que no normal inclui `SYSTEM`, `Administrators` e às vezes um SID
não resolvido, todos com controle total. Isso já aconteceu duas vezes neste
projeto: com `id_rsa` (achado e corrigido numa sessão anterior) e de novo
com `deploy_key_ci` (achado em 04/10/2026, só quando o usuário pediu pra
conferir — `icacls` mostrava 4 contas com `(F)` por herança).

**Sempre que gerar uma chave privada nova neste projeto** (`ssh-keygen -f
~/.ssh/nome_da_chave`), rodar na sequência, sem esperar dar erro de "Bad
permissions" ou alguém pedir pra conferir:

```powershell
icacls "C:\Users\work\.ssh\nome_da_chave" /inheritance:r
icacls "C:\Users\work\.ssh\nome_da_chave" /grant:r "$($env:USERNAME):(R)"
```

Não confiar no `ls -la` do Git Bash pra validar isso — ele traduz a ACL do
NTFS pra uma permissão POSIX aproximada (mostrou `644` pras duas chaves,
mesmo uma estando certa e a outra não). A fonte de verdade no Windows é
sempre `icacls`.

## Estilo de código: comentar generosamente, com preâmbulo

Diferente do padrão genérico de "comentar só quando o PORQUÊ não é óbvio",
**neste repositório o código é fortemente comentado** — é assim que o
projeto inteiro já está escrito (`src/config.ts`, `src/orchestrator/*.ts`,
`src/server.ts`, etc.) e é assim que deve continuar, inclusive em código
novo (telas HTML/JS novas como `public/whatsapp.html` e
`public/settings.html` seguiram a mesma regra). Esta instrução SOBRESCREVE
qualquer padrão default de "evite comentários" para este projeto.

Concretamente:

1. **Toda função/método/classe não trivial ganha um bloco "Preâmbulo:"**
   logo acima (ou como primeira linha do corpo, quando o preâmbulo precisa
   ficar dentro da função) explicando: o que a peça faz, quem chama ela e
   quando, e por que ela existe/por que foi desenhada assim — não só "o
   quê", mas o raciocínio por trás.
2. **Comentários linha a linha dentro do corpo**, explicando decisões não
   óbvias à medida que aparecem — tipo de dado escolhido, por que uma
   ordem de operações importa, qual bug/incidente motivou uma checagem
   específica, trade-off considerado e descartado. Uma linha de código só
   fica sem comentário quando o que ela faz já é auto-evidente a partir do
   nome das variáveis/funções.
3. **Comentários em português**, no mesmo tom explicativo e detalhado do
   resto do código já existente — não frases telegráficas tipo "// loop
   principal", e sim o contexto de verdade (ex.: por que um campo é
   `readonly`, por que uma validação roda ANTES de outra, o que quebraria
   se o comentário fosse ignorado).
4. Isso vale tanto pra arquivos `.ts` quanto pra HTML/CSS/JS das telas em
   `public/` — comentar blocos de CSS não óbvios e funções JS do mesmo
   jeito.

Motivo: o código aqui é lido e mantido por alguém (humano ou Claude) sem
contexto prévio de por que cada decisão foi tomada — o comentário é o que
preserva esse raciocínio entre sessões, em vez de ele se perder.

## Outros documentos relevantes

- `docs/STATUS.md` — checklist consolidado do que está feito/pendente, nos três repositórios do projeto.
- `docs/GO_LIVE_CHECKLIST.md` — passos manuais de domínio/email/canais.
- `docs/artifacts/` — docs de arquitetura publicados (Blueprint do Agente, Mapa de Capacidades).
