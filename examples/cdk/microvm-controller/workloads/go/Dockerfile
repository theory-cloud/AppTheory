FROM golang:1.26-alpine AS build
WORKDIR /src
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/server main.go

FROM alpine:3.22
WORKDIR /app
COPY --from=build /out/server ./server
EXPOSE 8080
CMD ["./server"]
