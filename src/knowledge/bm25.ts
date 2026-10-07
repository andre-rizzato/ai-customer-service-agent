// BM25 "na unha" — porta TypeScript de CursoClaude/ai/week11/hybrid_search.py
// e do mesmo algoritmo já usado no AgentService irmão
// (DistributedOrderSystem/src/AgentService/rag/bm25.py). Stopwords em
// português aqui (não inglês como a versão do AgentService), porque o
// catálogo e as perguntas dos clientes deste projeto são em português.
//
// Por que BM25 ao lado de busca vetorial: embedding é bom pra "do que isso
// trata", ruim pra termo raro e exato — um SKU ou código de produto não tem
// vizinho semântico pra generalizar. BM25 é "conta palavra em comum,
// ponderado pela raridade" — o oposto, e é por isso que combinar os dois
// (ver hybridSearch.ts) cobre mais caso do que qualquer um sozinho.

// Lista curta e específica deste corpus — não uma lista genérica de
// biblioteca — mesma filosofia da versão em inglês do AgentService: só as
// palavras que de fato aparecem com frequência alta o bastante pra precisar
// de filtro.
const STOPWORDS_PT = new Set([
  "o", "a", "os", "as", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "que", "com", "se",
  "e", "ou", "um", "uma", "uns", "umas", "ja", "ao", "aos",
  "foi", "por", "para", "pelo", "pela", "apos", "depois",
  "é", "são", "não", "tem", "mais",
]);

// Preâmbulo: tokenize() faz minúsculas + separa em qualquer caractere não
// alfanumérico, descartando stopword. Sem stemming, sem remoção de acento —
// mesma decisão da versão em Python, pelo mesmo motivo: stopword de fato
// esconde ruído no corpus, acento/stemming não esconderiam nada relevante.
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  for (const c of text.toLowerCase()) {
    if (/[a-z0-9áàâãéêíóôõúüç]/.test(c)) {
      word += c;
    } else if (word) {
      tokens.push(word);
      word = "";
    }
  }
  if (word) tokens.push(word);
  return tokens.filter((t) => !STOPWORDS_PT.has(t));
}

// Preâmbulo: idf() — termo raro no corpus inteiro (ex.: o nome de um
// produto específico) pesa mais que termo comum (ex.: "produto", que
// aparece em quase todo item). As constantes +0.5/+1 evitam log(0)/log de
// negativo quando o termo aparece em quase todo documento — parte da
// fórmula original do BM25, não um ajuste nosso.
function idf(term: string, tokenizedDocs: string[][]): number {
  const nDocs = tokenizedDocs.length;
  const nWithTerm = tokenizedDocs.filter((doc) => doc.includes(term)).length;
  return Math.log((nDocs - nWithTerm + 0.5) / (nWithTerm + 0.5) + 1);
}

// Preâmbulo: bm25Score() — pontuação de UM documento contra a query. k1
// controla saturação por frequência de termo (a 5a ocorrência da palavra
// importa bem menos que a 1a); b controla normalização por tamanho (um
// documento longo não deveria vencer só por ser longo). k1=1.5/b=0.75 são
// os valores padrão de livro-texto, não algo calibrado pra este catálogo.
function bm25Score(query: string, docTokens: string[], tokenizedDocs: string[][], k1 = 1.5, b = 0.75): number {
  const avgDocLen = tokenizedDocs.reduce((sum, d) => sum + d.length, 0) / tokenizedDocs.length;
  const termFreq = new Map<string, number>();
  for (const t of docTokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of tokenize(query)) {
    const f = termFreq.get(term) ?? 0;
    if (f === 0) continue; // termo da query nem aparece neste doc - contribuição zero
    const numerator = f * (k1 + 1);
    const denominator = f + k1 * (1 - b + (b * docTokens.length) / avgDocLen);
    score += idf(term, tokenizedDocs) * (numerator / denominator);
  }
  return score;
}

// Preâmbulo: bm25Rank() — ordena `docs` contra `query`, devolvendo pares
// (score, índice original) do maior pro menor. Devolve ÍNDICE, não o texto
// (diferente da versão didática do curso) — pool de candidatos de produção
// pode ter textos duplicados/parecidos, e o índice é a única forma
// inequívoca de mapear de volta pro documento certo em hybridSearch.ts.
export function bm25Rank(query: string, docs: string[]): [number, number][] {
  const tokenizedDocs = docs.map(tokenize);
  const scores: [number, number][] = tokenizedDocs.map((docTokens, i) => [
    bm25Score(query, docTokens, tokenizedDocs),
    i,
  ]);
  scores.sort((a, b) => b[0] - a[0]);
  return scores;
}
