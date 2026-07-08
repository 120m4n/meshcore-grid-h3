FROM node:20-slim AS build
WORKDIR /src
COPY package.json ./
RUN npm install
COPY . .
ARG PUBLIC_API_URL
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
