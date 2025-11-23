# qPCR Calculations (React + FastAPI)

Paste sample lists, pick genes/chemistry/replicates, set controls/overage, and get 384-well layouts plus master-mix totals. Styled to match the timeline app’s dark Premiere-like look. Playwright smoke produces the screenshots and a short video below (backend calls are mocked for captures).

Latest captures (Playwright):

| Plan | Plate preview | Output table | Master mix | Notes |
| --- | --- | --- | --- | --- |
| ![Plan](screenshots/plan_tab.png) | ![Plate preview](screenshots/plate_preview.png) | ![Output](screenshots/output_tab.png) | ![Master mix](screenshots/master_tab.png) | ![Notes](screenshots/notes_tab.png) |

Run-through video:

<video src="screenshots/example_run.webm" controls width="820"></video>

## Highlights
- Input: tab/comma/space-separated `Sample,Conc` with header.
- Logic parity with legacy: fixed reagents (10x buffer, dNTPs, random primers, enzyme), 20 µl final, 10% overage default, pre-dilution suggestions below 0.5 µl RNA, master mix summary row.
- Outputs: interactive table, CSV export, Excel export, clipboard TSV.
- Example data: `example_data/samples.csv`.

## Setup (D:)
```bash
cd "<PROJECTS_DIR>/cDNA-calculations-app/modern-app"
# If node_modules is missing
npm install
# Backend deps
python3 -m venv .venv
./.venv/bin/pip install --break-system-packages -r backend/requirements.txt
```

## Run (dev)
```bash
npm run dev:full   # front :5176, API :8003
```
Open http://localhost:5176, toggle **Use Example Data**, and click **Calculate Volumes**.

## Tests & screenshot
```bash
npx playwright install --with-deps chromium   # once, if not already installed
npm run test:e2e
```
The E2E starts both servers, runs the example flow, and writes `screenshots/example_run.png`.

## API
- `POST /calculate` → rows + master_mix (body: samples[], target_ng, overage_pct, use_example?)
- `POST /export-excel` → Excel workbook with the grid
- `GET /example`, `GET /health`

All endpoints honor `use_example: true` to run without user data.
