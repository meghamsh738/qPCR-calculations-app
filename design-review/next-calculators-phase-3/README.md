# qPCR Planner Next: rendered review

Reviewed 17 November 2026 using fictional samples in separate, temporary headless browser contexts. The checked-out branch was `codex/easylab-next-20261113`, based on `bac2fa6`, with the phase 3 changes uncommitted at capture time. This folder is evidence for those changes; it is not an installed release.

The preview was started from this Next checkout with `npm run dev`, using Node 24.22.1 and its isolated Python 3.11.18 environment. Frontend and API listened only on `127.0.0.1:19512` and `127.0.0.1:18512`. Both task-owned processes and browser contexts were closed after review. The Browser plugin was unavailable, so module-local Playwright and the Next browser cache were used.

## Evidence

- `planner-01-layout-desktop.png`: first run, with an empty sample list and no required browser folder setup.
- `planner-02-primer-stock-desktop.png` and `planner-09-recipe-units-narrow.png`: 100 µM stock warning and corrected µL / ng/µL labels at desktop and 768 px.
- `planner-03-96-well-desktop.png` and `planner-04-384-well-desktop.png`: the two plate formats, computed color-coded wells, and review states.
- `planner-05-layout-narrow.png` and `planner-06-keyboard-narrow.png`: 768 px package reopen and keyboard navigation.
- `planner-07-template-stock-desktop.png`: the two fictional sample occurrences, each requiring 8 µL across four assays; one has 8 µL available and one remains unknown.
- `planner-08-custom-mix-desktop.png`: the added fictional reagent appears with its calculated per-reaction and batch volumes.
- `planner-final-qa.json`: 79 passed assertions: 62 in the main flow, 11 in a separate fresh-context reopen, and 6 in the focused unit-label recheck. The downloaded mix CSV was independently parsed and compared with calculated values.

The original main-flow log stopped at an incorrect test expectation that an exactly matching reviewed package should require a new review. The accepted behavior restores review after recalculation confirms that the saved layout, mix and template budget match. The separate fresh-context reopen verified that behavior. The aggregate result reports the two actual runs and the focused CSS recheck; it does not claim that the whole flow was rerun. The original `planner-qa-result.json` remains in the task work directory with its obsolete `ok: false` assertion for transparency.

The actual handoff CSV contained 12 well rows, four assays, two plates, and two distinct fictional sample IDs. A separate fixture exercised the unchanged qPCR Analysis parser and its production Plate-and-Well sample-information join; all rows matched while instrument Cq values and labels were retained. This was not a full Analysis UI test.

Checked synthetic downloads are included here: [analysis handoff](planner-96-analysis-handoff.csv), [custom mix](planner-custom-mix.csv), and [reopenable experiment](planner-practice.qpcr-planner.json). The [export check](planner-export-check.json) and [Analysis join check](handoff-verification.json) record their agreement.

Raw logs and scripts are in `/Users/meghamsh/Documents/Codex/2026-11-13/files-pasted-by-the-user-help-2/work/calculators-phase-3/planner-qa/`. The join result is in the adjacent `handoff-verification.json`.

## Source identity at capture

SHA-256 values after the focused label fix:

```text
d3c36373c2cf9ac3bcc9e94a60a889852f47861bdb575cd46ba2412987de5df0  modern-app/src/App.tsx
02f540b6a33db62763ec317fc643ba5cc557b92fbc4a00ab0a988a0cdfc44c60  modern-app/src/App.css
2b255b3b4a9426e174a967f7b696e9c8a8e1dcd9c9087d0a239bcbd59765bf5d  modern-app/src/RecipeWorkflow.tsx
a44463f63c4dfb1fd07b84761f7ad56b974b1e4a8a00bc09a6689602e63623af  modern-app/backend/main.py
5b7970803a993abdbb16e0e4291240a935d4eda1a902e8c2bbe7364f72461d82  modern-app/backend/template_budget.py
b4944c1d023b7f4a9a723cc0b025761d8108901055c97bfed2d90a9e87690ee7  modern-app/index.html
```

The main workflow screenshots were captured before the last scoped CSS fix. Only the recipe and dilution field-label case changed; those affected views were recaptured after the fix.
