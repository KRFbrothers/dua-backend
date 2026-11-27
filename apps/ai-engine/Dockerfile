FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ARG DUA_BUILD_SHA=development
ARG REQUIREMENTS=requirements-adapters-lock.txt
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080 DUA_BUILD_SHA=$DUA_BUILD_SHA \
    ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=""
WORKDIR /app
COPY requirements*.txt ./
RUN python -m pip install --no-cache-dir -r "$REQUIREMENTS" && python -m pip check
RUN groupadd --gid 10001 dua && useradd --uid 10001 --gid dua --no-create-home dua
COPY --chown=dua:dua *.py ./
COPY --chown=dua:dua dua_engine/ ./dua_engine/
COPY --chown=dua:dua adk_examples/ ./adk_examples/
COPY --chown=dua:dua evals/ ./evals/
USER 10001:10001
EXPOSE 8080
# Probe /healthz, not /. `/` answers 200 even when the Supabase or Vertex credentials
# have expired, so it cannot tell a working revision from a broken one. /healthz is
# liveness only (no network, no credentials), which is what a container healthcheck
# wants: a dependency outage must not restart an otherwise healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"
CMD ["python", "adk_server.py"]
