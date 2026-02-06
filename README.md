# qPCR Calculations App (modern)

Modern React + FastAPI app for qPCR plate calculations. The web app lives in `modern-app/`.

Part of **Easylab Suite**: when bundled, it launches from the suite desktop launcher as the **qPCR Planner** module.

License: All Rights Reserved.

Latest UI (refreshed Dec 28, 2025 via `npm run test:e2e`, 80-sample multi-plate run with Plate 2 selected in preview):

| App overview | Plate preview | Output table | Master mix |
| --- | --- | --- | --- |
| ![App](modern-app/screenshots/example_run.png) | ![Plate](modern-app/screenshots/plate_preview.png) | ![Output](modern-app/screenshots/output_tab.png) | ![Mix](modern-app/screenshots/master_tab.png) |

- Full gallery + setup/run/test docs: `modern-app/README.md`
- Legacy/other scripts: see `LEGACY.md`.

## Desktop Installer (Windows)
From the repo root (next to this README):

```bash
npm install
npm run build:electron
```

The installer is generated in `desktop/dist/` as an `.exe` (NSIS). On first run, the app asks for storage folders and creates them for you.

Notes:
- The packaged app expects Python 3.10+ available on PATH to run the FastAPI backend. You can set `APP_PYTHON_PATH` to a specific Python executable if needed.
- The installer is unsigned unless code-signing credentials are configured.
