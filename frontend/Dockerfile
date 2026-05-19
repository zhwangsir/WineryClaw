FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install -g pnpm && pnpm install

COPY . .
RUN pnpm build

EXPOSE 8587

CMD ["pnpm", "preview", "--port", "8587", "--host"]
