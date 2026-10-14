FROM node:22-bookworm-slim AS airtable-deps
WORKDIR /airtable
COPY integrations/airtable/package*.json ./
RUN npm ci --omit=dev

FROM python:3.12-slim

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends libpq-dev gcc curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV AIRTABLE_NODE_BINARY=/usr/local/bin/node

COPY --from=airtable-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=airtable-deps /airtable/node_modules /app/integrations/airtable/node_modules

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
