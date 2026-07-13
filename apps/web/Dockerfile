FROM node:20-slim AS build
WORKDIR /src
COPY package.json ./
RUN npm install
COPY . .
ARG PUBLIC_API_URL
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
RUN npm run build

FROM nginx:1.27-alpine
# tzdata no viene en la imagen alpine base — sin esto, TZ=America/Bogota
# (env var, ver docker-compose) no tiene zoneinfo que cargar y los logs
# de nginx quedan en UTC.
RUN apk add --no-cache tzdata
COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
