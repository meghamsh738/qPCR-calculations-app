"""
qPCR plate planner API (96/384-well, EasyLab Next)
Ported from the legacy Tkinter helper: keeps placement rules, mix math, and exports.
"""

import re
from copy import deepcopy
from collections import defaultdict
from dataclasses import dataclass
from math import ceil
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .template_budget import template_budget

from .recipes import (
    evaluate_recipe,
    legacy_qpcr_recipe,
    master_mix,
    number as recipe_number,
    plan_dilution,
    validate_recipe,
)

APP_TITLE = "qPCR Planner API"

PLATE_DIMENSIONS = {
    96: (list("ABCDEFGH"), list(range(1, 13))),
    384: (list("ABCDEFGHIJKLMNOP"), list(range(1, 25))),
}
PRIMER_CONCENTRATIONS_UM = {"stock": 100.0, "working": 10.0}

class Gene(BaseModel):
    name: str
    chemistry: str  # "SYBR" or "TaqMan"

class PlanRequest(BaseModel):
    experiment_id: str = "plan"
    num_samples: int = 0
    num_standards: int = 8
    num_pos: int = 0
    replicates: int = 2
    overage_pct: float = 10.0
    primer_source: Literal["stock", "working"] = "working"
    place_gapdh_separate: bool = False
    include_rtneg: bool = True
    include_rnaneg: bool = True
    use_pasted_samples: bool = False
    pasted_samples: List[str] = []  # lines of "Name[tab/comma/space]Group" (Group optional)
    genes: List[Gene] = []
    gene_plate_overrides: Dict[str, int] = {}  # gene -> desired plate number (1-based)
    plate_format: Literal[96, 384] = 384
    recipes: Dict[str, Dict[str, Any]] = {}
    sample_concentration_ng_ul: Optional[float] = None
    template_available_ul: Dict[str, Any] = Field(default_factory=dict)


class RecipeEvaluationRequest(BaseModel):
    recipe: Dict[str, Any]
    reaction_count: int = 1
    sample_concentration_ng_ul: Optional[float] = None
    ceil_reactions: bool = False


class DilutionRequest(BaseModel):
    stock_concentration: float
    working_concentration: float
    needed_volume_ul: float
    min_pipette_ul: float = 0.5
    available_stock_ul: Optional[float] = None
    overage_pct: float = 0

class MixRow(BaseModel):
    Gene: str
    Chemistry: str
    placed_reactions: int
    mix_factor: float
    mix_equiv_rxn: float
    master_mix_2x: float
    rna_free_h2o: float
    probe_10uM: float
    primer_concentration_uM: float
    fwd_primer_ul: float
    rev_primer_ul: float

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
    allow_origins=["*"],
    allow_credentials=False,
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


@dataclass(frozen=True)
class ParsedSample:
    """One input row, identified independently from its visible label."""

    index: int
    label: str
    extras: Tuple[str, ...]


def _split_sample_line(raw: str) -> List[str]:
    """Return tokens for a sample line.

    Priority:
    1) Tabs or commas keep intra-value spaces intact.
    2) Compact patterns like 321Maletnfold age are unpacked via regex.
    3) Fallback: whitespace split, with "old age"/"middle age" re-joined.
    """

    line = raw.rstrip("\r\n")
    if not line.strip() or line.lstrip().startswith("#"):
        return []

    if "\t" in line:
        return [part.strip() for part in line.split("\t")]
    if "," in line:
        return [part.strip() for part in line.split(",")]

    # Compact case: remove internal spaces so "tnfold age" still matches.
    compact = re.sub(r"\s+", "", line.strip())
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

    parts = [p for p in re.split(r"\s+", line.strip()) if p]
    if len(parts) >= 2 and parts[-2].lower() in {"old", "middle"} and parts[-1].lower() == "age":
        parts = parts[:-2] + [f"{parts[-2]} {parts[-1]}"]
    return parts


def parse_samples(lines: List[str]) -> Tuple[List[ParsedSample], List[str]]:
    """Parse pasted sample lines ->
    (ordered sample occurrences, headers_for_extras).

    - First token is always treated as the sample label.
    - Extras are every remaining token, preserving order.
    - Repeated labels remain separate sample occurrences.
    - If only one extra column exists, it keeps the legacy name "Group".
    """

    samples: List[ParsedSample] = []
    max_extras = 0

    for line_number, ln in enumerate(lines, start=1):
        parts = _split_sample_line(ln)
        if not parts:
            continue
        label, *extras = parts
        if not label:
            raise ValueError(f"Sample line {line_number} has a blank first column. Add a sample label or remove the row.")
        samples.append(ParsedSample(index=len(samples) + 1, label=label, extras=tuple(extras)))
        max_extras = max(max_extras, len(extras))

    if max_extras == 1:
        headers = ["Group"]
    else:
        headers = [f"Extra {i}" for i in range(1, max_extras + 1)]

    return samples, headers


def _sample_volume_and_mass(recipe: Dict[str, Any], sample_concentration_ng_ul: Optional[float]):
    sample_input = recipe.get("sample_input", {})
    value = recipe_number(sample_input.get("value")) if isinstance(sample_input, dict) else None
    mode = sample_input.get("mode") if isinstance(sample_input, dict) else None
    concentration = recipe_number(sample_concentration_ng_ul)
    sample_volume = None
    input_mass_ng = None
    issues: List[str] = []

    if mode == "volume" and value is not None:
        sample_volume = value
        if concentration is not None and concentration > 0:
            input_mass_ng = sample_volume * concentration
    elif mode == "mass" and value is not None:
        input_mass_ng = value
        if concentration is None or concentration <= 0:
            issues.append("Enter sample concentration (ng/µL) to calculate the volume for this mass input.")
        else:
            sample_volume = value / concentration
    elif mode not in ("mass", "volume"):
        issues.append("Choose whether sample input is entered as mass or volume.")

    limits = recipe.get("constraints", {}) if isinstance(recipe.get("constraints"), dict) else {}
    max_input = recipe_number(limits.get("max_input_ng"))
    if max_input is not None:
        if input_mass_ng is None:
            issues.append("Enter sample concentration to check the declared maximum input mass.")
        elif input_mass_ng > max_input:
            issues.append(f"Sample input {input_mass_ng:g} ng exceeds the declared kit limit of {max_input:g} ng.")
    return sample_volume, input_mass_ng, issues


def _recipe_assessment(
    recipe: Dict[str, Any],
    sample_concentration_ng_ul: Optional[float],
    reaction_count: int,
    ceil_reactions: bool = False,
):
    """Evaluate recipe inputs and pooled transfers using the shared v1 engine."""
    validation = validate_recipe(recipe)
    if validation:
        empty_eval = {
            "components": [], "water_ul": None,
            "total_volume_ul": recipe_number(recipe.get("total_volume_ul")),
            "sample_volume_ul": None, "issues": list(validation),
        }
        return {"evaluation": empty_eval, "master_mix": {"components": [], "reaction_equivalents": 0, "issues": list(validation)}, "issues": list(validation), "input_mass_ng": None, "dilutions": []}

    sample_volume, input_mass_ng, input_issues = _sample_volume_and_mass(recipe, sample_concentration_ng_ul)
    evaluation = evaluate_recipe(recipe, sample_volume)
    evaluation["issues"] = list(dict.fromkeys(evaluation["issues"] + input_issues))

    mix = master_mix(recipe, evaluation, reaction_count, ceil_reactions=ceil_reactions, include_water=True)
    issues = list(dict.fromkeys(evaluation["issues"] + mix["issues"]))
    minimum = recipe_number(recipe.get("min_pipette_ul"))
    if minimum is not None and sample_volume is not None and 0 < sample_volume < minimum:
        issues.append(f"Sample input transfer {sample_volume:g} µL is below the {minimum:g} µL pipetting minimum.")

    # A low-volume primer stock transfer is never silently treated as pipetteable.
    # Offer a same-dose working dilution for 100 µM primer stocks when appropriate.
    dilution_plans = []
    equivalents = mix.get("reaction_equivalents", 0)
    for component in recipe.get("components", []):
        if not isinstance(component, dict) or component.get("name") not in ("Forward primer", "Reverse primer"):
            continue
        if component.get("mode") != "concentration" or component.get("stock_unit") != "uM" or component.get("final_unit") != "uM":
            continue
        stock = recipe_number(component.get("stock"))
        final = recipe_number(component.get("final"))
        per_reaction = next((c.get("volume_ul") for c in evaluation.get("components", []) if c.get("name") == component.get("name")), None)
        total = recipe_number(per_reaction)
        total = total * equivalents if total is not None else None
        if stock is None or final is None or total is None or minimum is None or total >= minimum or stock < 50 or final <= 0:
            continue
        target_working = min(10.0, stock / 2.0)
        needed_working = final / target_working * recipe_number(recipe.get("total_volume_ul")) * equivalents
        dilution = plan_dilution(stock, target_working, needed_working, minimum, overage_pct=0)
        dilution_plans.append({
            "component": component["name"],
            "stock_concentration": stock,
            "working_concentration": target_working,
            "unit": "µM",
            "stock_ul": dilution["stock_ul"],
            "water_ul": dilution["water_ul"],
            "total_ul": dilution["total_ul"],
            "factor": dilution["factor"],
            "issues": dilution["issues"],
            "note": "This dilution keeps the same final primer concentration; update the recipe stock to the working concentration before planning this batch.",
        })

    return {
        "evaluation": evaluation,
        "master_mix": mix,
        "issues": list(dict.fromkeys(issues)),
        "input_mass_ng": input_mass_ng,
        "dilutions": dilution_plans,
    }


def _recipe_for(chemistry: str, primer_source: str, overrides: Dict[str, Dict[str, Any]], overage_pct: float):
    supplied = overrides.get(chemistry)
    recipe = deepcopy(supplied) if supplied else legacy_qpcr_recipe(chemistry, primer_source)
    # The legacy layout endpoint has always treated overage as a request-level option.
    if not supplied:
        recipe["overage_pct"] = overage_pct
    return recipe


@app.get("/recipes/presets")
async def recipe_presets():
    """Return the four legacy assay/primer presets as editable recipe documents."""
    return {
        "version": 1,
        "presets": [
            {
                "key": f"{chemistry.casefold()}:{primer_source}",
                "chemistry": chemistry,
                "primer_source": primer_source,
                "recipe": {
                    **legacy_qpcr_recipe(chemistry, primer_source),
                    "name": f"Legacy {chemistry} — 15 µL · {100 if primer_source == 'stock' else 10} µM primers",
                },
            }
            for chemistry in ("SYBR", "TaqMan")
            for primer_source in ("working", "stock")
        ],
    }


@app.post("/recipe/evaluate")
async def evaluate_recipe_endpoint(req: RecipeEvaluationRequest):
    """Evaluate one reaction and a pooled batch without moving math into the UI."""
    if req.reaction_count < 0:
        raise HTTPException(status_code=400, detail="Reaction count must be non-negative.")
    return _recipe_assessment(
        req.recipe,
        req.sample_concentration_ng_ul,
        req.reaction_count,
        ceil_reactions=req.ceil_reactions,
    )


@app.post("/recipe/dilution")
async def dilution_endpoint(req: DilutionRequest):
    """Plan an explicitly requested dilution without changing a recipe silently."""
    return plan_dilution(
        req.stock_concentration,
        req.working_concentration,
        req.needed_volume_ul,
        req.min_pipette_ul,
        available_stock_ul=req.available_stock_ul,
        overage_pct=req.overage_pct,
    )

@app.post("/plan")
async def plan(req: PlanRequest):
    plate_rows, plate_cols = PLATE_DIMENSIONS[req.plate_format]
    wells_per_row = len(plate_cols)
    wells_per_plate = len(plate_rows) * wells_per_row
    if req.replicates < 1:
        raise HTTPException(status_code=400, detail="Replicates must be ≥ 1.")
    experiment_id = req.experiment_id.strip()
    if not experiment_id or len(experiment_id) > 120 or any(ord(char) < 32 for char in experiment_id):
        raise HTTPException(status_code=400, detail="Experiment ID must be non-empty and at most 120 characters.")
    if req.num_samples < 0 or req.num_standards < 0 or req.num_pos < 0:
        raise HTTPException(status_code=400, detail="Sample and control counts must be non-negative.")
    if recipe_number(req.overage_pct) is None or not 0 <= req.overage_pct <= 100:
        raise HTTPException(status_code=400, detail="Mix overage must be between 0 and 100%.")
    labels_per_row = wells_per_row // req.replicates
    if labels_per_row < 1:
        raise HTTPException(status_code=400, detail="Replicates too large for 24 columns.")

    if req.use_pasted_samples:
        try:
            samples, sample_headers = parse_samples(req.pasted_samples)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        if not samples:
            raise HTTPException(status_code=400, detail="No samples parsed from pasted list.")
    else:
        samples = [ParsedSample(index=i, label=f"S{i}", extras=()) for i in range(1, req.num_samples + 1)]
        sample_headers: List[str] = []
        if not samples:
            raise HTTPException(status_code=400, detail="Enter at least one sample or choose a positive sample count.")

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

    # Placement rules:
    # - Do NOT mix chemistries on the same physical plate.
    # - Pack multiple genes of the same chemistry onto as few plates as possible.
    # - A gene starts at column 1 (i.e., the start of a fresh row) even if the previous gene
    #   ended mid-row; we waste the remainder of that row so genes stay visually grouped.
    #
    # We preserve gene order within each chemistry (stable by first appearance).
    chemistry_groups: List[Tuple[str, List[Tuple[str, str]]]] = []
    for group_genes in gene_groups:
        by_chem: Dict[str, List[Tuple[str, str]]] = {}
        chem_order: List[str] = []
        for gene, chem_key in group_genes:
            if chem_key not in by_chem:
                by_chem[chem_key] = []
                chem_order.append(chem_key)
            by_chem[chem_key].append((gene, chem_key))
        for chem_key in chem_order:
            chemistry_groups.append((chem_key, by_chem[chem_key]))

    recipes_by_chemistry: Dict[str, Dict[str, Any]] = {}
    for _, chemistry in genes:
        if chemistry not in CHEMISTRY:
            raise HTTPException(status_code=400, detail=f"Unknown chemistry: {chemistry}")
        if chemistry not in recipes_by_chemistry:
            recipe = _recipe_for(chemistry, req.primer_source, req.recipes, req.overage_pct)
            recipes_by_chemistry[chemistry] = recipe

    all_layout = []
    all_mix: List[dict] = []
    plates_dict: Dict[str, List[dict]] = defaultdict(list)
    plate_counter = 0

    current_plate = None
    row_idx = 0
    col_idx = 0

    def start_new_plate(target_plate=None):
        nonlocal plate_counter, current_plate, row_idx, col_idx
        if target_plate and target_plate > plate_counter + 1:
            # Keep numbering stable if the user pins a gene to a later plate.
            plate_counter = target_plate - 1
        plate_counter += 1
        current_plate = f"Plate {plate_counter}"
        row_idx = 0
        col_idx = 0

    for chem_key, group_genes in chemistry_groups:
        if chem_key not in CHEMISTRY:
            # Fail early with a chemistry-focused error even if multiple genes share it.
            bad_gene = next((g for g, c in group_genes if c == chem_key), "unknown")
            raise HTTPException(status_code=400, detail=f"Unknown chemistry for {bad_gene}: {chem_key}")

        # New chemistry group always starts on a fresh plate (no mixing).
        current_plate = None
        row_idx = 0
        col_idx = 0

        for gene, gene_chem_key in group_genes:

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
            if rows_needed > len(plate_rows):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Gene '{gene}' needs {total_labels} labels × {req.replicates} reps "
                        f"= {total_labels*req.replicates} wells over {rows_needed} rows (>{wells_per_plate})."
                    ),
                )

            override_plate = req.gene_plate_overrides.get(gene) or None

            # Ensure the gene starts on a plate >= override_plate (if provided).
            if current_plate is None:
                start_new_plate(override_plate)
            elif override_plate and plate_counter < override_plate:
                start_new_plate(override_plate)
            elif row_idx + rows_needed > len(plate_rows):
                start_new_plate(override_plate)

            # New gene always starts at the first column of a row.
            col_idx = 0
            placed_for_gene = 0

            def place_block(label_type: str, labels: List[Union[str, ParsedSample]]):
                nonlocal row_idx, col_idx, placed_for_gene
                for sample_or_label in labels:
                    if col_idx + req.replicates > wells_per_row:
                        col_idx = 0
                        row_idx += 1
                    if row_idx >= len(plate_rows):
                        raise HTTPException(status_code=400, detail="Plate overflow while placing wells.")
                    sample = sample_or_label if isinstance(sample_or_label, ParsedSample) else None
                    lab = sample.label if sample else str(sample_or_label)
                    extras = list(sample.extras) if sample else []
                    if len(extras) < max_extras:
                        extras = extras + [""] * (max_extras - len(extras))
                    for r in range(req.replicates):
                        well = f"{plate_rows[row_idx]}{plate_cols[col_idx + r]}"
                        record = {
                            "Plate": current_plate,
                            "Well": well,
                            "Gene": gene,
                            "Type": label_type,
                            "Label": lab,
                            "Replicate": r + 1,
                        }
                        if sample:
                            record["SampleIndex"] = sample.index
                            record["SampleId"] = f"{experiment_id}:SAMPLE-{sample.index:05d}"
                            record["Group"] = extras[0] if extras else ""
                            record["Extras"] = extras
                        all_layout.append(record)
                        plates_dict[current_plate].append(record)
                        placed_for_gene += 1
                    col_idx += req.replicates
                    if col_idx >= wells_per_row:
                        col_idx = 0
                        row_idx += 1

            for label_type, labels in sections:
                place_block(label_type, labels)

            # End-of-gene alignment: do not let the next gene start mid-row.
            if col_idx != 0:
                col_idx = 0
                row_idx += 1

            recipe = recipes_by_chemistry[gene_chem_key]
            assessment = _recipe_assessment(
                recipe,
                req.sample_concentration_ng_ul,
                placed_for_gene,
            )
            batch = assessment["master_mix"]
            component_rows = batch.get("components", [])
            individual_transfers = [
                {
                    "name": component["name"],
                    "per_well_ul": component["volume_ul"],
                    "total_ul": component["volume_ul"] * placed_for_gene,
                }
                for component in assessment["evaluation"].get("components", [])
                if not component.get("in_master_mix")
            ]
            totals = {str(row.get("name", "")).casefold(): row.get("total_ul", 0.0) for row in component_rows}

            def component_total(*names):
                for name in names:
                    value = recipe_number(totals.get(name.casefold()))
                    if value is not None:
                        return value
                return 0.0

            primer = next((c for c in recipe.get("components", []) if c.get("name") == "Forward primer"), None)
            primer_concentration = recipe_number(primer.get("stock")) if primer else PRIMER_CONCENTRATIONS_UM[req.primer_source]
            overage = recipe_number(recipe.get("overage_pct"))
            factor = 1.0 + ((overage if overage is not None else req.overage_pct) / 100.0)
            evaluation = assessment["evaluation"]
            all_mix.append({
                "Gene": gene,
                "Chemistry": gene_chem_key,
                "placed_reactions": placed_for_gene,
                "mix_factor": factor,
                "mix_equiv_rxn": batch.get("reaction_equivalents", 0),
                "master_mix_2x": component_total("2X master mix"),
                "rna_free_h2o": component_total("water", "rnase-free h2o", "rna-free h2o"),
                "probe_10uM": component_total("probe", "10 µm probe"),
                "primer_concentration_uM": primer_concentration,
                "fwd_primer_ul": component_total("forward primer", "10 µm forward"),
                "rev_primer_ul": component_total("reverse primer", "10 µm reverse"),
                "recipe_name": recipe.get("name", "Custom recipe"),
                "reaction_volume_ul": recipe_number(recipe.get("total_volume_ul")),
                "sample_volume_ul": evaluation.get("sample_volume_ul"),
                "water_per_reaction_ul": evaluation.get("water_ul"),
                "components": component_rows,
                "individual_transfers": individual_transfers,
                "recipe_issues": assessment["issues"],
                "dilutions": assessment["dilutions"],
            })

    summary = [
        {"plate": p, "used": len(plates_dict[p]), "empty": wells_per_plate - len(plates_dict[p])}
        for p in sorted(plates_dict.keys(), key=lambda x: int(x.split()[1]))
    ]

    return {
        "layout": all_layout,
        "mix": all_mix,
        "template_budget": template_budget(all_layout, all_mix, req.template_available_ul),
        "plates": plates_dict,
        "summary": summary,
        "sample_headers": sample_headers,
        "plate_format": req.plate_format,
        "wells_per_plate": wells_per_plate,
        "inputs": req.dict(),
    }

@app.get("/health")
async def health():
    return {"status": "ok", "app": "qpcr-planner", "version": "next"}
