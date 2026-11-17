"""Per-experiment template use; never infers stock availability or adds mix overage."""

import math

from .recipes import number


def template_budget(layout, mixes, availability):
    volumes = {row["Gene"]: number(row.get("sample_volume_ul")) for row in mixes}
    samples = {}
    for well in layout:
        if well.get("Type") != "Sample":
            continue
        sample_id = well.get("SampleId", "")
        row = samples.setdefault(
            sample_id,
            {
                "sample_id": sample_id,
                "label": well.get("Label", ""),
                "group": well.get("Group", ""),
                "well_count": 0,
                "assays": [],
                "required_ul": None,
                "available_ul": None,
                "status": "unknown",
                "issues": [],
                "_volumes": [],
            },
        )
        row["well_count"] += 1
        gene = well["Gene"]
        if gene not in row["assays"]:
            row["assays"].append(gene)
        row["_volumes"].append(volumes.get(gene))
        if (row["label"], row["group"]) != (
            well.get("Label", ""),
            well.get("Group", ""),
        ):
            row["issues"].append("Sample identity has inconsistent labels or groups.")

    issues = []
    if set(availability) - set(samples):
        issues.append(
            "An available volume belongs to a different sample map. Clear it and review the current samples."
        )
    for sample_id, row in samples.items():
        doses = row.pop("_volumes")
        if any(value is None or value <= 0 for value in doses):
            row["issues"].append(
                "Resolve the reaction input before calculating template use."
            )
        else:
            try:
                required = math.fsum(doses)
                if not math.isfinite(required):
                    raise OverflowError
                row["required_ul"] = required
            except OverflowError:
                row["issues"].append(
                    "Total template volume is outside the supported numeric range."
                )
        raw = availability.get(sample_id)
        unknown = raw is None or (isinstance(raw, str) and not raw.strip())
        if not unknown:
            row["available_ul"] = number(raw)
            if row["available_ul"] is None or row["available_ul"] < 0:
                row["issues"].append(
                    "Available template must be a non-negative volume in µL, or left blank if unknown."
                )
        if row["issues"]:
            row["status"] = "invalid"
        elif unknown:
            row["status"] = "unknown"
        elif row["available_ul"] < row["required_ul"] - 1e-9:
            row["status"] = "insufficient"
            row["issues"].append(
                f"Needs {row['required_ul']:g} µL; only {row['available_ul']:g} µL is available."
            )
        else:
            row["status"] = "enough"
        row["issues"] = list(dict.fromkeys(row["issues"]))
        issues.extend(f"{row['label']}: {issue}" for issue in row["issues"])
    rows = list(samples.values())
    return {
        "rows": rows,
        "issues": list(dict.fromkeys(issues)),
        "unknown_count": sum(row["status"] == "unknown" for row in rows),
    }
