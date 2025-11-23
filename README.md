# qPCR Calculations App

Modern React + FastAPI planner for 384‑well QuantStudio 5 plates. Paste samples, set genes/chemistry/replicates, and get plate layouts plus master‑mix totals. Playwright tests auto-generate the screenshots below.

## Quick start

```bash
cd modern-app
# install
npm install
# ensure backend venv is available (adjust path if needed)
ln -s <VENV_DIR> .venv

# dev servers (front :5176, API :8003)
npm run dev:full
```

## Tests & screenshots

```bash
npm run test:e2e   # runs Playwright and regenerates screenshots
```
Screenshots live in `modern-app/screenshots/`:

| Plan | Layout | Plate preview | Master mix | Notes |
| --- | --- | --- | --- | --- |
| ![Plan](modern-app/screenshots/plan_tab.png) | ![Layout](modern-app/screenshots/output_tab.png) | ![Plate](modern-app/screenshots/plate_preview.png) | ![Master mix](modern-app/screenshots/master_mix.png) | ![Notes](modern-app/screenshots/notes_tab.png) |

## More details

See `modern-app/README.md` for full feature list, API notes, and extra screenshots.

