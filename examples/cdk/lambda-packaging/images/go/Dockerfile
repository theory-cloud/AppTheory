FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /asset/bootstrap .

FROM public.ecr.aws/lambda/provided:al2023
ARG IMAGE_VALUE=go-image-build
COPY --from=build /asset/bootstrap /var/task/bootstrap
RUN printf '%s' "$IMAGE_VALUE" > /var/task/image-value.txt
CMD ["bootstrap"]
