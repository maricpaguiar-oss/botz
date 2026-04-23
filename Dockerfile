FROM node:18-slim

# Instala dependências do sistema: python3, pip, ffmpeg e yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip3 install yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "bot.js"]