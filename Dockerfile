FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY db ./db
RUN bun build src/cli/contextual.ts --compile --outfile /app/contextual

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 unzip poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 contextual \
    && useradd --uid 10001 --gid contextual --create-home contextual \
    && mkdir -p /app/blobs && chown -R contextual:contextual /app
COPY --from=build /app/contextual /usr/local/bin/contextual
WORKDIR /app
ENV CONTEXTUAL_OCR=local CONTEXTUAL_OCR_LANGUAGE=eng CONTEXTUAL_BLOB_DIR=/app/blobs
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["contextual"]
CMD ["serve", "--transport", "http", "--host", "0.0.0.0", "--port", "3000"]
