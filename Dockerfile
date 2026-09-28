# Build multi-stage: o estágio "build" tem as devDependencies (typescript,
# tsx, tipos) só para compilar; a imagem final só carrega o JS compilado e
# as dependências de produção — mais leve e sem ferramentas de build na
# imagem que vai rodar de verdade.

FROM node:22-slim AS build
WORKDIR /app

# Copia primeiro só os manifestos de dependência para aproveitar o cache de
# camadas do Docker — "npm ci" só reroda se package.json/package-lock.json
# mudarem, não a cada alteração de código-fonte.
COPY package.json package-lock.json ./
RUN npm ci

# Agora copia o restante do código e compila TypeScript -> JavaScript
# (dist/), conforme tsconfig.json.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- estágio final: imagem enxuta para rodar em produção ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copia manifestos de novo e instala SÓ as dependências de produção
# (sem typescript/tsx/vitest, que só existem no estágio de build).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia o JavaScript já compilado do estágio de build.
COPY --from=build /app/dist ./dist

# Configuração do negócio e catálogo — copia explicitamente os arquivos de
# EXEMPLO (nunca a pasta inteira, que poderia incluir por acaso um
# agent.config.json real deixado no diretório local de build) como
# fallback funcional. Em um deploy real, sobrescreva os dois via volume
# (ver docs/DEPLOYMENT_GUIDE) ou builde uma imagem própria por cliente
# copiando os arquivos reais no lugar destes.
COPY config/agent.config.example.json ./config/agent.config.json
COPY knowledge/catalog.example.json ./knowledge/catalog.json

# Diretório de dados (histórico de conversas, log de auditoria, índice
# vetorial) — pensado para ser montado como volume, já que precisa
# sobreviver a um restart/redeploy do container.
RUN mkdir -p /app/data

EXPOSE 3000

# Roda o JavaScript já compilado com o "node" puro da imagem final — não
# precisa de tsx aqui porque não há mais TypeScript para transpilar em
# tempo de execução.
CMD ["node", "dist/src/server.js"]
