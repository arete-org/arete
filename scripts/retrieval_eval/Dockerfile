FROM python:3.12.13-slim
RUN pip install --no-cache-dir duckdb==1.4.2 sqlglot==30.22.0
WORKDIR /eval
COPY engine.py sql_worker.py catalog.json /eval/
USER 65534:65534
ENTRYPOINT ["python", "-B", "/eval/sql_worker.py"]
