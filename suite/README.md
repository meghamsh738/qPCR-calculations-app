# Suite Integration (Easylab Suite)

This folder contains the integration contract for bundling this repo into the `easylab-suite` desktop launcher.

## What the suite expects
- Front-end build output at `.app-dist/web/` (Vite build from `modern-app/`).
- FastAPI backend at `backend/main.py` (bundled into the suite under `apps/qpcr-planner/backend`).

## Module metadata
See `suite/module.json`.
