"""
qPCR plate planner API (384-well, QuantStudio 5)
Ported from the legacy Tkinter helper: keeps placement rules, mix math, and exports.
"""

import re
from collections import defaultdict
from math import ceil
from typing import Dict, List, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

APP_TITLE = "qPCR Planner API"

PLATE_ROWS = list("ABCDEFGHIJKLMNOP")  # 16 rows
PLATE_COLS = list(range(1, 25))        # 24 cols
WELLS_PER_ROW = len(PLATE_COLS)
WELLS_PER_PLATE = len(PLATE_ROWS) * len(PLATE_COLS)  # 384

class Gene(BaseModel):
    name: str
    chemistry: str  # "SYBR" or "TaqMan"

class PlanRequest(BaseModel):
    num_samples: int = 70
    num_standards: int = 8
    num_pos: int = 0
    replicates: int = 2
    overage_pct: float = 10.0
    place_gapdh_separate: bool = False
    include_rtneg: bool = True
    include_rnaneg: bool = True
    use_pasted_samples: bool = False
    pasted_samples: List[str] = []  # lines of "Name[tab/comma/space]Group" (Group optional)
    genes: List[Gene] = []
    gene_plate_overrides: Dict[str, int] = {}  # gene -> desired plate number (1-based)

class MixRow(BaseModel):
    Gene: str
    Chemistry: str
    placed_reactions: int
    mix_factor: float
    mix_equiv_rxn: float
    master_mix_2x: float
    rna_free_h2o: float
    probe_10uM: float
    fwd_10uM: float
    rev_10uM: float

CHEMISTRY = {
    "SYBR": {
        "2X master mix": 7.5,
        "RNAse-free H2O": 4.9,
        "10 µM probe": 0.0,
        "10 µM Forward": 0.3,
        "10 µM Reverse": 0.3,
    },
    "TaqMan": {
        "2X master mix": 7.5,
        "RNAse-free H2O": 4.6,
        "10 µM probe": 0.3,
        "10 µM Forward": 0.3,
        "10 µM Reverse": 0.3,
    },
}

app = FastAPI(title=APP_TITLE)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5176",
        "http://127.0.0.1:5176",
        "http://localhost:5177",
        "http://127.0.0.1:5177",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COMPACT_SAMPLE_RE = re.compile(
    r"^(?P<label>[A-Za-z0-9]+)"
    r"(?P<sex>male|female)"
    r"(?P<treatment>tnf|saline)"
    r"(?P<age>middleage|oldage)$",
    re.IGNORECASE,
)


def _split_sample_line(raw: str) -> List[str]:
    """Return tokens for a sample line.

    Priority:
    1) Tabs or commas keep intra-value spaces intact.
    2) Compact patterns like 321Maletnfold age are unpacked via regex.
    3) Fallback: whitespace split, with "old age"/"middle age" re-joined.
    """

    line = raw.strip()
    if not line or line.startswith("#"):
        return []

    if "\t" in line or "," in line:
        return [p.strip() for p in re.split(r"[\t,]+", line) if p.strip()]

    # Compact case: remove internal spaces so "tnfold age" still matches.
    compact = re.sub(r"\s+", "", line)
    m = COMPACT_SAMPLE_RE.match(compact)
    if m:
        age_key = m.group("age").lower()
        age = "middle age" if "middle" in age_key else "old age"
        return [
            m.group("label"),
            m.group("sex").capitalize(),
            m.group("treatment").lower(),
            age,
        ]

    parts = [p for p in re.split(r"\s+", line) if p]
    if len(parts) >= 2 and parts[-2].lower() in {"old", "middle"} and parts[-1].lower() == "age":
        parts = parts[:-2] + [f"{parts[-2]} {parts[-1]}"]
    return parts


def parse_samples(lines: List[str]) -> Tuple[List[str], Dict[str, str], Dict[str, List[str]], List[str]]:
    """Parse pasted sample lines ->
    (ordered names, name->group, name->extras[], headers_for_extras).

    - First token is always treated as the sample label.
    - Extras are every remaining token, preserving order.
    - If only one extra column exists, it keeps the legacy name "Group".
    """

    names: List[str] = []
    group_map: Dict[str, str] = {}
    extras_map: Dict[str, List[str]] = {}
    max_extras = 0

    for ln in lines:
        parts = _split_sample_line(ln)
        if not parts:
            continue
        label, *extras = parts
        if label in extras_map:
            continue  # preserve first occurrence order
        names.append(label)
        extras_map[label] = extras
        if extras:
            group_map[label] = extras[0]
        max_extras = max(max_extras, len(extras))

    if max_extras == 1:
        headers = ["Group"]
    else:
        headers = [f"Extra {i}" for i in range(1, max_extras + 1)]

    return names, group_map, extras_map, headers

@app.post("/plan")
async def plan(req: PlanRequest):
    if req.replicates < 1:
        raise HTTPException(status_code=400, detail="Replicates must be ≥ 1.")
    labels_per_row = WELLS_PER_ROW // req.replicates
    if labels_per_row < 1:
        raise HTTPException(status_code=400, detail="Replicates too large for 24 columns.")

    if req.use_pasted_samples:
        samples, sample_group_map, sample_extra_map, sample_headers = parse_samples(req.pasted_samples)
        if not samples:
            raise HTTPException(status_code=400, detail="No samples parsed from pasted list.")
    else:
        samples = [f"S{i}" for i in range(1, req.num_samples + 1)]
        sample_group_map = {}
        sample_extra_map = {}
        sample_headers: List[str] = []

    max_extras = len(sample_headers)

    if not req.genes:
        raise HTTPException(status_code=400, detail="At least one gene is required.")

    genes = [(g.name.strip(), g.chemistry.strip()) for g in req.genes if g.name.strip()]
    seen = set()
    for g, _ in genes:
        if g in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate gene: {g}")
        seen.add(g)

    gene_groups: List[List[Tuple[str, str]]] = []
    if req.place_gapdh_separate:
        non_gapdh = [(g, c) for g, c in genes if g.lower() != "gapdh"]
        gapdh_only = [(g, c) for g, c in genes if g.lower() == "gapdh"]
        if non_gapdh:
            gene_groups.append(non_gapdh)
        if gapdh_only:
            gene_groups.append(gapdh_only)
    else:
        gene_groups.append(genes)

    all_layout = []
    all_mix: List[dict] = []
    plates_dict: Dict[str, List[dict]] = defaultdict(list)
    plate_counter = 0

    for group_genes in gene_groups:
        row_idx = 0
        for gene, chem_key in group_genes:
            if chem_key not in CHEMISTRY:
                raise HTTPException(status_code=400, detail=f"Unknown chemistry for {gene}: {chem_key}")

            sections = []
            sections.append(("Sample", samples))
            sections.append(("Standard", [f"Std{n}" for n in range(1, req.num_standards + 1)]))
            if req.num_pos > 0:
                sections.append(("Positive", [f"Pos{n}" for n in range(1, req.num_pos + 1)]))
            if req.include_rtneg:
                sections.append(("Negative", ["RT−"]))
            if req.include_rnaneg:
                sections.append(("Negative", ["RNA−"]))
            sections.append(("Blank", ["Blank"]))
            sections = [(t, [x for x in xs if x]) for (t, xs) in sections if xs]

            total_labels = sum(len(lbls) for _, lbls in sections)
            rows_needed = ceil(total_labels / labels_per_row)
            if rows_needed > len(PLATE_ROWS):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Gene '{gene}' needs {total_labels} labels × {req.replicates} reps "
                        f"= {total_labels*req.replicates} wells over {rows_needed} rows (>384)."
                    ),
                )

            override_plate = req.gene_plate_overrides.get(gene)
            if override_plate and override_plate > plate_counter:
                plate_counter = override_plate - 1
                row_idx = 0

            if row_idx + rows_needed > len(PLATE_ROWS) or (plate_counter == 0 and row_idx == 0):
                plate_counter += 1
                current_plate = f"Plate {plate_counter}"
                row_idx = 0
            else:
                current_plate = f"Plate {plate_counter}"

            chem = CHEMISTRY[chem_key]
            col_idx = 0
            placed_for_gene = 0

            def place_block(label_type: str, labels: List[str]):
                nonlocal row_idx, col_idx, placed_for_gene
                for lab in labels:
                    if col_idx + req.replicates > WELLS_PER_ROW:
                        col_idx = 0
                        row_idx += 1
                    if row_idx >= len(PLATE_ROWS):
                        raise HTTPException(status_code=400, detail="Plate overflow while placing wells.")
                    extras = sample_extra_map.get(lab, []) if label_type == "Sample" else []
                    if len(extras) < max_extras:
                        extras = extras + [""] * (max_extras - len(extras))
                    for r in range(req.replicates):
                        well = f"{PLATE_ROWS[row_idx]}{PLATE_COLS[col_idx + r]}"
                        record = {
                            "Plate": current_plate,
                            "Well": well,
                            "Gene": gene,
                            "Type": label_type,
                            "Label": lab,
                            "Replicate": r + 1,
                        }
                        if label_type == "Sample":
                            record["Group"] = sample_group_map.get(lab, "")
                            record["Extras"] = extras
                        all_layout.append(record)
                        plates_dict[current_plate].append(record)
                        placed_for_gene += 1
                    col_idx += req.replicates
                    if col_idx >= WELLS_PER_ROW:
                        col_idx = 0
                        row_idx += 1

            for label_type, labels in sections:
                place_block(label_type, labels)

            if col_idx != 0:
                col_idx = 0
                row_idx += 1

            factor = 1.0 + (req.overage_pct / 100.0)
            mix_equiv_rxn = placed_for_gene * factor
            all_mix.append({
                "Gene": gene,
                "Chemistry": chem_key,
                "placed_reactions": placed_for_gene,
                "mix_factor": factor,
                "mix_equiv_rxn": mix_equiv_rxn,
                "master_mix_2x":  chem["2X master mix"]  * mix_equiv_rxn,
                "rna_free_h2o":   chem["RNAse-free H2O"] * mix_equiv_rxn,
                "probe_10uM":     chem["10 µM probe"]    * mix_equiv_rxn,
                "fwd_10uM":       chem["10 µM Forward"]  * mix_equiv_rxn,
                "rev_10uM":       chem["10 µM Reverse"]  * mix_equiv_rxn,
            })

    summary = [
        {"plate": p, "used": len(plates_dict[p]), "empty": WELLS_PER_PLATE - len(plates_dict[p])}
        for p in sorted(plates_dict.keys(), key=lambda x: int(x.split()[1]))
    ]

    return {
        "layout": all_layout,
        "mix": all_mix,
        "plates": plates_dict,
        "summary": summary,
        "sample_headers": sample_headers,
        "inputs": req.dict(),
    }

@app.get("/health")
async def health():
    return {"status": "ok"}
