.PHONY: venv weights test test-docker image
venv:
	virtualenv --system-site-packages .venv || python3 -m venv --system-site-packages .venv
	.venv/bin/pip install -q -r requirements-dev.txt
weights:
	.venv/bin/python scripts/fetch-weights.py
test:
	.venv/bin/python -m pytest -q
test-docker:
	docker build --target test -t stamper-ml:test .
image:
	docker build -t stamper-ml .
