import asyncio
import re
import unittest

from fastapi import HTTPException

from backend.main import Gene, PlanRequest, _recipe_assessment, parse_samples, plan
from backend.recipes import legacy_qpcr_recipe, validate_recipe


def run(coro):
    return asyncio.run(coro)


class PlannerRecipeTests(unittest.TestCase):
    def test_legacy_primer_stock_and_working_recipes_preserve_the_same_final_dose(self):
        working = legacy_qpcr_recipe("SYBR", "working")
        stock = legacy_qpcr_recipe("SYBR", "stock")
        working_result = _recipe_assessment(working, None, 20)
        stock_result = _recipe_assessment(stock, None, 20)

        self.assertAlmostEqual(working_result["evaluation"]["water_ul"], 4.9)
        self.assertAlmostEqual(stock_result["evaluation"]["water_ul"], 5.44)
        for primer_name in ("Forward primer", "Reverse primer"):
            work_component = next(c for c in working["components"] if c["name"] == primer_name)
            stock_component = next(c for c in stock["components"] if c["name"] == primer_name)
            work_volume = next(c["volume_ul"] for c in working_result["evaluation"]["components"] if c["name"] == primer_name)
            stock_volume = next(c["volume_ul"] for c in stock_result["evaluation"]["components"] if c["name"] == primer_name)
            self.assertAlmostEqual(work_component["stock"] * work_volume / 15, 0.2)
            self.assertAlmostEqual(stock_component["stock"] * stock_volume / 15, 0.2)
            self.assertAlmostEqual(work_volume, 0.3)
            self.assertAlmostEqual(stock_volume, 0.03)

    def test_small_pooled_stock_transfer_is_flagged_with_same_dose_working_dilution(self):
        recipe = legacy_qpcr_recipe("TaqMan", "stock")
        result = _recipe_assessment(recipe, None, 1)

        self.assertTrue(any("pipetting minimum" in issue for issue in result["issues"]))
        guidance = [item for item in result["dilutions"] if item["component"] == "Forward primer"]
        self.assertTrue(guidance)
        self.assertEqual(guidance[0]["stock_concentration"], 100)
        self.assertEqual(guidance[0]["working_concentration"], 10)
        self.assertGreaterEqual(guidance[0]["stock_ul"], 0.5)
        self.assertAlmostEqual(guidance[0]["factor"], 10)

    def test_mass_input_converts_to_volume_and_enforces_declared_kit_limit(self):
        recipe = legacy_qpcr_recipe("SYBR", "working")
        recipe["sample_input"] = {"mode": "mass", "value": 100, "unit": "ng"}
        recipe["constraints"].update({"source": "Kit instructions, revision 2", "max_input_ng": 75})

        result = _recipe_assessment(recipe, 50, 8)

        self.assertAlmostEqual(result["evaluation"]["sample_volume_ul"], 2)
        self.assertAlmostEqual(result["input_mass_ng"], 100)
        self.assertTrue(any("exceeds the declared kit limit of 75 ng" in issue for issue in result["issues"]))

    def test_declared_kit_limits_require_a_source(self):
        recipe = legacy_qpcr_recipe("SYBR", "working")
        recipe["constraints"]["max_sample_ul"] = 2
        self.assertTrue(any("source" in issue.lower() for issue in validate_recipe(recipe)))

    def test_blank_first_sample_column_is_not_shifted_into_a_label(self):
        with self.assertRaisesRegex(ValueError, "blank first column"):
            parse_samples(["\tTreated"])

    def test_empty_count_mode_request_does_not_create_placeholder_samples(self):
        with self.assertRaises(HTTPException) as error:
            run(plan(PlanRequest(
                num_standards=0,
                num_pos=0,
                include_rtneg=False,
                include_rnaneg=False,
                genes=[Gene(name="Target", chemistry="SYBR")],
            )))
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("Enter at least one sample", error.exception.detail)

    def test_declared_sample_volume_limit_is_reported_in_plan_issues(self):
        recipe = legacy_qpcr_recipe("SYBR", "working")
        recipe["constraints"].update({"source": "Kit instructions", "max_sample_ul": 1})
        response = run(plan(PlanRequest(
            experiment_id="sample-limit",
            use_pasted_samples=True,
            pasted_samples=["Mouse-1"],
            num_standards=0,
            num_pos=0,
            replicates=1,
            include_rtneg=False,
            include_rnaneg=False,
            genes=[Gene(name="Target", chemistry="SYBR")],
            plate_format=96,
            recipes={"SYBR": recipe},
        )))

        self.assertIn("Sample volume exceeds the declared kit limit.", response["mix"][0]["recipe_issues"])

    def test_96_well_layout_uses_capacity_and_experiment_scoped_sample_ids(self):
        response = run(plan(PlanRequest(
            experiment_id="experiment-a",
            use_pasted_samples=True,
            pasted_samples=["Mouse-7\tcontrol", "Mouse-7\ttreated"],
            num_standards=0,
            num_pos=0,
            replicates=2,
            include_rtneg=False,
            include_rnaneg=False,
            genes=[Gene(name="Reference", chemistry="SYBR"), Gene(name="Target", chemistry="SYBR")],
            plate_format=96,
        )))

        self.assertEqual(response["plate_format"], 96)
        self.assertEqual(response["wells_per_plate"], 96)
        sample_rows = [row for row in response["layout"] if row["Type"] == "Sample"]
        self.assertTrue(all(re.fullmatch(r"[A-H](?:[1-9]|1[0-2])", row["Well"]) for row in sample_rows))
        ids = {row["SampleId"] for row in sample_rows if row["Label"] == "Mouse-7"}
        self.assertEqual(ids, {"experiment-a:SAMPLE-00001", "experiment-a:SAMPLE-00002"})
        for sample_id in ids:
            self.assertEqual(len({row["Gene"] for row in sample_rows if row["SampleId"] == sample_id}), 2)

    def test_96_well_layout_rejects_a_gene_block_that_cannot_fit(self):
        with self.assertRaises(HTTPException) as error:
            run(plan(PlanRequest(
                use_pasted_samples=True,
                pasted_samples=[f"Sample{i}" for i in range(48)],
                num_standards=0,
                num_pos=0,
                replicates=2,
                include_rtneg=False,
                include_rnaneg=False,
                genes=[Gene(name="Target", chemistry="SYBR")],
                plate_format=96,
            )))
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("over 9 rows (>96)", error.exception.detail)


if __name__ == "__main__":
    unittest.main()
