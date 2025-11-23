# cDNA Calculations (React + FastAPI)

Modern rewrite of the RT mix helper. Paste sample concentrations, set a target ng, and get per-sample RNA/H₂O volumes, pre-dilution guidance when pipet volumes are too small, and master-mix totals. CSV/Excel export and clipboard copy are built in. Playwright E2E drives the bundled example and regenerates the screenshot.

Screenshots
------------
Latest autoplay set (Playwright)
| Plan (pre-calc) | Full layout + mix | Master mix card | Notes card |
| --- | --- | --- | --- |
| ![Plan view](screenshots/plan_view.png) | ![Full layout](screenshots/layout_full.png) | ![Master mix card](screenshots/master_mix.png) | ![Notes card](screenshots/notes_card.png) |

Tab views
| Plan tab | Output table | Master mix | Notes & rules |
| --- | --- | --- | --- |
| ![Plan tab](screenshots/plan_tab.png) | ![Output table](screenshots/output_tab.png) | ![Master mix](screenshots/master_tab.png) | ![Notes & rules](screenshots/notes_tab.png) |

End-to-end example
| Example run |
| --- |
| ![Example run](screenshots/example_run.png) |

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
