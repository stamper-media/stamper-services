# syntax=docker/dockerfile:1
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /srv/ml
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY scripts/fetch-weights.py scripts/
# FETCH_WEIGHTS=0 builds without weights; then mount them at /models.
ARG FETCH_WEIGHTS=1
ARG TRUSTMARK_WEIGHTS_URL=
RUN mkdir -p /models && if [ "$FETCH_WEIGHTS" = "1" ]; then python scripts/fetch-weights.py --dest /models; fi

FROM deps AS test
COPY requirements-dev.txt pytest.ini ./
RUN pip install pytest httpx
COPY app app
COPY tests tests
ENV MODELS_DIR=/models
RUN python -m pytest -q

FROM python:3.12-slim AS runtime
RUN useradd --system --uid 10001 --no-create-home ml && mkdir -p /srv/staging
COPY --from=deps /opt/venv /opt/venv
COPY --from=deps /models /models
WORKDIR /srv/ml
COPY app app
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 \
    ML_PORT=8000 MODELS_DIR=/models TRUSTMARK_VARIANT=Q TRUSTMARK_SCHEMA=BCH_SUPER \
    TRUSTMARK_STRENGTH=1.0 TORCH_NUM_THREADS=4 STAGING_DIR=/srv/staging \
    MAX_IMAGE_PIXELS=50000000 ML_WATERMARK=trustmark
USER ml
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/health'%os.environ.get('ML_PORT','8000'),timeout=4)"
CMD ["python", "-m", "app.main"]
