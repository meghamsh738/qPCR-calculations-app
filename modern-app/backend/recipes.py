"""Version 1 reaction recipe math, mirrored byte-for-byte in both Next calculators.

No kit claims are inferred. Fixed aliquots stay fixed when a recipe permits
volume scaling; fractional and concentration components follow reaction volume.
"""

import math
from copy import deepcopy

ENGINE_VERSION = "next-recipes-1"
UNITS = {
    "nM": ("molar", 0.001),
    "uM": ("molar", 1.0),
    "mM": ("molar", 1000.0),
    "ng/uL": ("mass", 1.0),
    "ug/uL": ("mass", 1000.0),
    "mg/mL": ("mass", 1000.0),
    "X": ("fold", 1.0),
    "U/uL": ("activity", 1.0),
}


def number(value):
    if isinstance(value, bool):
        return None
    try:
        v = float(value)
        return v if math.isfinite(v) else None
    except (ValueError, TypeError, OverflowError):
        return None


def concentration_ratio(stock, stock_unit, final, final_unit):
    a, b = number(stock), number(final)
    if a is None or a <= 0 or b is None or b < 0:
        raise ValueError(
            "Stock concentration must be positive and final concentration non-negative."
        )
    if (
        not isinstance(stock_unit, str)
        or not isinstance(final_unit, str)
        or stock_unit not in UNITS
        or final_unit not in UNITS
        or UNITS[stock_unit][0] != UNITS[final_unit][0]
    ):
        raise ValueError(
            "Stock and final concentration units must describe the same quantity."
        )
    denominator, numerator = a * UNITS[stock_unit][1], b * UNITS[final_unit][1]
    if (
        denominator <= 0
        or not math.isfinite(denominator)
        or not math.isfinite(numerator)
    ):
        raise ValueError("Concentrations are outside the supported numeric range.")
    ratio = numerator / denominator
    if not math.isfinite(ratio):
        raise ValueError("The concentration ratio must be finite.")
    return ratio


def validate_recipe(recipe):
    if not isinstance(recipe, dict):
        return ["Choose a valid recipe."]
    issues = []
    if recipe.get("version") != 1:
        issues.append("Unsupported recipe version.")
    if not isinstance(recipe.get("name"), str) or not recipe["name"].strip():
        issues.append("Give the recipe a name.")
    for key in ("total_volume_ul", "reference_volume_ul", "min_pipette_ul"):
        if number(recipe.get(key)) is None or number(recipe[key]) <= 0:
            issues.append(
                f"{ {'total_volume_ul':'Reaction volume','reference_volume_ul':'Original recipe volume','min_pipette_ul':'Minimum pipetting volume'}[key]} must be positive and finite."
            )
    overage = number(recipe.get("overage_pct"))
    if overage is None or not 0 <= overage <= 100:
        issues.append("Overage must be between 0 and 100%.")
    if not isinstance(recipe.get("allow_scaling"), bool):
        issues.append("Confirm whether volume scaling is permitted.")
    volume = number(recipe.get("total_volume_ul"))
    reference = number(recipe.get("reference_volume_ul"))
    if (
        volume
        and reference
        and not recipe.get("allow_scaling")
        and not math.isclose(volume, reference)
    ):
        issues.append(
            "This recipe does not permit a different reaction volume; create an explicitly scalable custom recipe."
        )
    sample = recipe.get("sample_input", {})
    if (
        not isinstance(sample, dict)
        or sample.get("mode") not in ("mass", "volume")
        or number(sample.get("value")) is None
        or number(sample["value"]) <= 0
    ):
        issues.append("Sample input must be a positive mass or volume.")
    elif sample.get("unit") != ("ng" if sample["mode"] == "mass" else "uL"):
        issues.append("Sample input uses ng for mass or uL for volume.")
    limits = recipe.get("constraints")
    if not isinstance(limits, dict):
        issues.append("Kit limits must be an object.")
        limits = {}
    defined = []
    for key in ("min_volume_ul", "max_volume_ul", "max_input_ng", "max_sample_ul"):
        val = limits.get(key)
        if val is not None:
            defined.append(key)
            if number(val) is None or number(val) <= 0:
                issues.append(
                    f"{ {'min_volume_ul':'Minimum reaction volume','max_volume_ul':'Maximum reaction volume','max_input_ng':'Maximum RNA input','max_sample_ul':'Maximum sample volume'}[key]} must be positive when declared."
                )
    if defined and (
        not isinstance(limits.get("source"), str) or not limits["source"].strip()
    ):
        issues.append("Give the source for declared kit limits.")
    minimum, maximum = number(limits.get("min_volume_ul")), number(
        limits.get("max_volume_ul")
    )
    if minimum and maximum and minimum > maximum:
        issues.append("Minimum reaction volume exceeds the declared maximum.")
    if volume and minimum and volume < minimum:
        issues.append("Reaction volume is below the declared kit minimum.")
    if volume and maximum and volume > maximum:
        issues.append("Reaction volume exceeds the declared kit maximum.")
    components = recipe.get("components")
    if not isinstance(components, list) or not 1 <= len(components) <= 30:
        return issues + ["Use 1–30 recipe components."]
    names = set()
    for component in components:
        if not isinstance(component, dict):
            issues.append("Invalid recipe component.")
            continue
        name = component.get("name", "")
        if (
            not isinstance(name, str)
            or not name.strip()
            or name.casefold() in names
            or name.casefold() in ("water", "sample")
        ):
            issues.append(
                "Components need unique names, distinct from Water and Sample."
            )
        elif isinstance(name, str):
            names.add(name.casefold())
        if not isinstance(component.get("in_master_mix"), bool):
            issues.append(
                f"{name}: declare whether this is prepared in the master mix."
            )
        mode = component.get("mode")
        if mode in ("fixed", "fraction"):
            value = number(component.get("value"))
            if value is None or value < 0 or (mode == "fraction" and value > 1):
                issues.append(
                    f"{name}: enter a non-negative aliquot or a fraction between 0 and 1."
                )
        elif mode == "concentration":
            try:
                concentration_ratio(
                    component.get("stock"),
                    component.get("stock_unit"),
                    component.get("final"),
                    component.get("final_unit"),
                )
            except ValueError as error:
                issues.append(f"{name}: {error}")
        else:
            issues.append(f"{name}: choose fixed, fraction or concentration mode.")
    return issues


def evaluate_recipe(recipe, sample_volume_ul=None):
    issues = validate_recipe(recipe)
    if not isinstance(recipe, dict):
        return {
            "components": [],
            "water_ul": None,
            "total_volume_ul": None,
            "sample_volume_ul": None,
            "issues": issues,
        }
    result = {
        "components": [],
        "water_ul": None,
        "total_volume_ul": number(recipe.get("total_volume_ul")),
        "sample_volume_ul": number(sample_volume_ul),
        "issues": issues,
    }
    if issues:
        return result
    volume = float(recipe["total_volume_ul"])
    if sample_volume_ul is None and recipe["sample_input"]["mode"] == "volume":
        sample_volume_ul = recipe["sample_input"]["value"]
    sample_volume = number(sample_volume_ul)
    result["sample_volume_ul"] = sample_volume
    for c in recipe["components"]:
        value = (
            (float(c["value"]) if c["mode"] == "fixed" else volume * float(c["value"]))
            if c["mode"] != "concentration"
            else volume
            * concentration_ratio(
                c["stock"], c["stock_unit"], c["final"], c["final_unit"]
            )
        )
        if not math.isfinite(value):
            issues.append(f"{c['name']}: calculated volume is not finite.")
            return result
        result["components"].append(
            {"name": c["name"], "volume_ul": value, "in_master_mix": c["in_master_mix"]}
        )
    if sample_volume is None or sample_volume < 0:
        issues.append("Supply a non-negative sample volume.")
        return result
    water = volume - sample_volume - sum(c["volume_ul"] for c in result["components"])
    if not math.isfinite(water):
        issues.append(
            "Calculated reaction volume is outside the supported numeric range."
        )
        return result
    if abs(water) < 1e-10:
        water = 0.0
    result["water_ul"] = water
    if water < 0:
        issues.append(
            f"Reaction exceeds total volume by {-water:g} uL; water would be negative."
        )
    maximum = number(recipe["constraints"].get("max_sample_ul"))
    if maximum and sample_volume > maximum:
        issues.append("Sample volume exceeds the declared kit limit.")
    return result


def master_mix(
    recipe, evaluated, n_reactions, ceil_reactions=False, include_water=True
):
    issues = list(evaluated["issues"])
    if issues:
        return {"components": [], "reaction_equivalents": 0, "issues": issues}
    if not isinstance(n_reactions, int) or n_reactions < 0:
        return {
            "components": [],
            "reaction_equivalents": 0,
            "issues": ["Reaction count must be a non-negative integer."],
        }
    factor = n_reactions * (1 + float(recipe["overage_pct"]) / 100)
    equivalents = math.ceil(factor - 1e-12) if ceil_reactions else factor
    rows = [
        {
            "name": c["name"],
            "per_reaction_ul": c["volume_ul"],
            "total_ul": c["volume_ul"] * equivalents,
        }
        for c in evaluated["components"]
        if c["in_master_mix"]
    ]
    if include_water and evaluated["water_ul"] is not None:
        rows.append(
            {
                "name": "Water",
                "per_reaction_ul": evaluated["water_ul"],
                "total_ul": evaluated["water_ul"] * equivalents,
            }
        )
    minimum = float(recipe["min_pipette_ul"])
    if n_reactions:
        for row in rows:
            if 0 < row["total_ul"] < minimum - 1e-10:
                issues.append(
                    f"{row['name']}: preparation transfer {row['total_ul']:g} uL is below the {minimum:g} uL pipetting minimum; prepare a suitable working dilution or a larger batch."
                )
        for c in evaluated["components"]:
            if not c["in_master_mix"] and 0 < c["volume_ul"] < minimum - 1e-10:
                issues.append(
                    f"{c['name']}: individual aliquot is below the pipetting minimum."
                )
    return {"components": rows, "reaction_equivalents": equivalents, "issues": issues}


def plan_dilution(
    stock_concentration,
    working_concentration,
    needed_volume_ul,
    min_pipette_ul,
    available_stock_ul=None,
    overage_pct=0,
):
    values = [
        number(v)
        for v in (
            stock_concentration,
            working_concentration,
            needed_volume_ul,
            min_pipette_ul,
            overage_pct,
        )
    ]
    result = {
        "stock_ul": None,
        "water_ul": None,
        "total_ul": None,
        "factor": None,
        "issues": [],
    }
    if (
        any(v is None for v in values)
        or any(v <= 0 for v in values[:4])
        or not 0 <= values[4] <= 100
    ):
        result["issues"] = [
            "Dilution concentrations, required volume and pipetting minimum must be positive; overage must be 0–100%."
        ]
        return result
    stock, working, needed, minimum, overage = values
    if working > stock:
        result["issues"] = ["Dilution cannot increase concentration."]
        return result
    factor = stock / working
    total = max(needed * (1 + overage / 100), minimum * factor)
    if factor > 1:
        total = max(total, minimum / (1 - 1 / factor))
    stock_volume, water = total / factor, total - total / factor
    if not all(math.isfinite(v) for v in (total, stock_volume, water, factor)):
        result["issues"] = ["Dilution volumes are not finite."]
        return result
    result.update(stock_ul=stock_volume, water_ul=water, total_ul=total, factor=factor)
    if available_stock_ul is not None and (
        number(available_stock_ul) is None
        or float(available_stock_ul) < stock_volume - 1e-10
    ):
        result["issues"].append("Insufficient stock volume for this preparation.")
    return result


def legacy_cdna_recipe():
    return {
        "version": 1,
        "name": "Legacy cDNA — 20 uL",
        "total_volume_ul": 20.0,
        "reference_volume_ul": 20.0,
        "allow_scaling": False,
        "min_pipette_ul": 0.5,
        "overage_pct": 10.0,
        "sample_input": {"mode": "mass", "value": 200.0, "unit": "ng"},
        "constraints": {
            "source": "",
            "min_volume_ul": None,
            "max_volume_ul": None,
            "max_input_ng": None,
            "max_sample_ul": None,
        },
        "components": [
            {
                "name": name,
                "mode": "fixed",
                "value": value,
                "stock": 1.0,
                "stock_unit": "X",
                "final": 1.0,
                "final_unit": "X",
                "in_master_mix": True,
            }
            for name, value in [
                ("10x buffer", 2.0),
                ("dNTPs", 0.8),
                ("Random primers", 2.0),
                ("Enzyme", 1.0),
            ]
        ],
    }


def legacy_qpcr_recipe(chemistry="SYBR", primer_source="working"):
    if chemistry not in ("SYBR", "TaqMan") or primer_source not in ("stock", "working"):
        raise ValueError("Unknown chemistry or primer source.")
    r = legacy_cdna_recipe()
    r.update(
        name=f"Legacy {chemistry} — 15 uL",
        total_volume_ul=15.0,
        reference_volume_ul=15.0,
        min_pipette_ul=0.5,
        sample_input={"mode": "volume", "value": 2.0, "unit": "uL"},
    )
    r["components"] = [
        {
            "name": "2X master mix",
            "mode": "concentration",
            "value": 0.0,
            "stock": 2.0,
            "stock_unit": "X",
            "final": 1.0,
            "final_unit": "X",
            "in_master_mix": True,
        }
    ]
    for name in ["Forward primer", "Reverse primer"] + (
        ["Probe"] if chemistry == "TaqMan" else []
    ):
        r["components"].append(
            {
                "name": name,
                "mode": "concentration",
                "value": 0.0,
                "stock": (
                    100.0 if primer_source == "stock" and name != "Probe" else 10.0
                ),
                "stock_unit": "uM",
                "final": 0.2,
                "final_unit": "uM",
                "in_master_mix": True,
            }
        )
    return deepcopy(r)
