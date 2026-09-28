// Configuração do Vitest (framework de testes). Existe como arquivo próprio
// (em vez de campo dentro do package.json) para poder injetar variáveis de
// ambiente ANTES de qualquer arquivo de teste ser carregado — necessário
// porque src/config.ts lê process.env e um arquivo de configuração no disco
// no momento em que é importado, e os testes importam módulos que, direta
// ou indiretamente, importam src/config.ts.
import { defineConfig } from "vitest/config";

// defineConfig só existe para dar autocomplete/checagem de tipos sobre o
// objeto de configuração — em tempo de execução é equivalente a exportar o
// objeto diretamente.
export default defineConfig({
  test: {
    // Roda os testes em ambiente Node puro (sem simular um DOM de
    // navegador) — apropriado porque este projeto é 100% backend.
    environment: "node",
    // Variáveis de ambiente injetadas SÓ no processo de teste, sem precisar
    // de um arquivo .env real:
    env: {
      // Aponta para o arquivo de config de EXEMPLO (versionado no repo) em
      // vez do config/agent.config.json real do negócio (que não existe em
      // CI e nem deveria ser necessário só para rodar testes unitários).
      AGENT_CONFIG_PATH: "./config/agent.config.example.json",
      // Chaves "falsas" só para satisfazer a validação de presença feita
      // pelas factories (createLLMProvider/createEmbeddingProvider) — os
      // testes que rodam em CI (handoff, promptBuilder, rateLimiter,
      // vectorStore) nunca chegam a chamar de fato essas APIs, então o
      // valor da chave é irrelevante, só precisa existir para não lançar o
      // erro de "chave ausente".
      ANTHROPIC_API_KEY: "test-key",
      VOYAGE_API_KEY: "test-key",
    },
  },
});
