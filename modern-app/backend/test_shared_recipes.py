import math
import unittest
from recipes import (
    concentration_ratio,
    evaluate_recipe,
    legacy_cdna_recipe,
    legacy_qpcr_recipe,
    master_mix,
    plan_dilution,
    validate_recipe,
)


class RecipeTests(unittest.TestCase):
    def test_legacy_cdna_composition_and_overage(self):
        r = legacy_cdna_recipe()
        e = evaluate_recipe(r, 4)
        self.assertAlmostEqual(e["water_ul"], 10.2)
        self.assertAlmostEqual(
            sum(c["volume_ul"] for c in e["components"]) + e["water_ul"] + 4, 20
        )
        mix = master_mix(r, e, 3, ceil_reactions=True, include_water=False)
        self.assertEqual(mix["reaction_equivalents"], 4)
        self.assertAlmostEqual(sum(c["total_ul"] for c in mix["components"]), 23.2)
        self.assertEqual(e["components"][3]["volume_ul"], 1)

    def test_explicit_component_scaling(self):
        r = legacy_cdna_recipe()
        r["total_volume_ul"] = 40
        self.assertTrue(validate_recipe(r))
        r["allow_scaling"] = True
        r["components"][0].update(mode="concentration", stock=10, final=1)
        r["components"][1].update(mode="fraction", value=0.04)
        e = evaluate_recipe(r, 4)
        self.assertEqual([c["volume_ul"] for c in e["components"]], [4, 1.6, 2, 1])
        self.assertAlmostEqual(e["water_ul"], 27.4)

    def test_stock_and_working_preserve_primer_dose(self):
        for chemistry in ("SYBR", "TaqMan"):
            working = evaluate_recipe(legacy_qpcr_recipe(chemistry, "working"))
            stock = evaluate_recipe(legacy_qpcr_recipe(chemistry, "stock"))
            self.assertAlmostEqual(
                working["components"][1]["volume_ul"] * 10,
                stock["components"][1]["volume_ul"] * 100,
            )
            self.assertAlmostEqual(
                sum(c["volume_ul"] for c in stock["components"])
                + stock["water_ul"]
                + 2,
                15,
            )

    def test_units_and_limits(self):
        self.assertAlmostEqual(concentration_ratio(10, "uM", 200, "nM"), 0.02)
        with self.assertRaises(ValueError):
            concentration_ratio(10, "X", 2, "uM")
        r = legacy_cdna_recipe()
        r["constraints"].update(source="Declared test kit", max_volume_ul=10)
        self.assertTrue(validate_recipe(r))
        r["constraints"]["max_volume_ul"] = 30
        r["constraints"]["source"] = ""
        self.assertTrue(validate_recipe(r))

    def test_negative_water_and_nonfinite_inputs(self):
        r = legacy_cdna_recipe()
        self.assertLess(evaluate_recipe(r, 20)["water_ul"], 0)
        r["overage_pct"] = math.nan
        self.assertTrue(validate_recipe(r))
        r["overage_pct"] = -10
        self.assertTrue(validate_recipe(r))

    def test_malformed_nested_recipe_and_unrepresentable_units_are_reported(self):
        r = legacy_cdna_recipe()
        del r["constraints"]
        self.assertIn("Kit limits must be an object.", validate_recipe(r))
        r = legacy_qpcr_recipe()
        r["components"][1]["stock_unit"] = []
        self.assertTrue(validate_recipe(r))
        with self.assertRaises(ValueError):
            concentration_ratio(1e-323, "nM", 1, "uM")

    def test_dilution_checks_every_transfer_and_stock(self):
        d = plan_dilution(100, 10, 2, 0.5)
        self.assertEqual(d["stock_ul"], 0.5)
        self.assertEqual(d["water_ul"], 4.5)
        self.assertEqual(d["total_ul"], 5)
        self.assertTrue(plan_dilution(100, 10, 2, 0.5, 0.1)["issues"])
        self.assertTrue(plan_dilution(10, 100, 2, 0.5)["issues"])

    def test_minimum_applies_to_actual_pooled_transfers(self):
        r = legacy_qpcr_recipe("SYBR", "stock")
        e = evaluate_recipe(r)
        self.assertTrue(master_mix(r, e, 1)["issues"])
        self.assertFalse(master_mix(r, e, 100)["issues"])


if __name__ == "__main__":
    unittest.main()
