import asyncio
import unittest
from backend.main import Gene, PlanRequest, plan
from backend.recipes import legacy_qpcr_recipe
from backend.template_budget import template_budget


class TemplateBudgetTests(unittest.TestCase):
    def test_sum_across_assays_plates_and_replicates_without_mix_overage(self):
        wells = [
            {
                "SampleId": "a",
                "Label": "Same label",
                "Group": "A",
                "Type": "Sample",
                "Gene": gene,
                "Plate": plate,
            }
            for plate, gene in [("Plate 1", "Tnf"), ("Plate 2", "Ref")]
            for _ in range(3)
        ]
        wells.append(
            {
                "SampleId": "b",
                "Label": "Same label",
                "Group": "B",
                "Type": "Sample",
                "Gene": "Tnf",
            }
        )
        wells.append({"Label": "Blank", "Type": "Blank", "Gene": "Tnf"})
        mixes = [
            {"Gene": "Tnf", "sample_volume_ul": 2, "mix_factor": 1.1},
            {"Gene": "Ref", "sample_volume_ul": 1, "mix_factor": 1.5},
        ]
        result = template_budget(wells, mixes, {"a": "8", "b": 2})
        a, b = result["rows"]
        self.assertEqual(
            (a["required_ul"], a["well_count"], a["status"]), (9, 6, "insufficient")
        )
        self.assertEqual((b["required_ul"], b["status"]), (2, "enough"))
        self.assertTrue(result["issues"])

    def test_unknown_invalid_and_stale_mapping_remain_explicit(self):
        wells = [{"SampleId": "a", "Label": "A", "Type": "Sample", "Gene": "Tnf"}]
        mix = [{"Gene": "Tnf", "sample_volume_ul": 2}]
        for raw in [None, "", "  "]:
            result = template_budget(wells, mix, {"a": raw})
            self.assertEqual(result["unknown_count"], 1)
            self.assertFalse(result["issues"])
        for raw in [-1, "bad", True, float("inf")]:
            result = template_budget(wells, mix, {"a": raw})
            self.assertEqual(result["rows"][0]["status"], "invalid")
            self.assertTrue(result["issues"])
        self.assertEqual(
            template_budget(wells, mix, {"a": 0})["rows"][0]["status"], "insufficient"
        )
        self.assertTrue(template_budget(wells, mix, {"previous-map": 100})["issues"])
        self.assertEqual(template_budget(wells, [], {})["rows"][0]["status"], "invalid")

    def test_api_budget_matches_all_planned_sample_wells_and_known_stock(self):
        sybr, taq = legacy_qpcr_recipe("SYBR"), legacy_qpcr_recipe("TaqMan")
        taq["sample_input"]["value"] = 3
        args = dict(
            experiment_id="fixture",
            use_pasted_samples=True,
            pasted_samples=["Repeated\tA", "Repeated\tB"],
            num_standards=0,
            num_pos=0,
            replicates=2,
            include_rtneg=False,
            include_rnaneg=False,
            genes=[
                Gene(name="Tnf", chemistry="SYBR"),
                Gene(name="Ref", chemistry="TaqMan"),
            ],
            recipes={"SYBR": sybr, "TaqMan": taq},
            plate_format=96,
        )
        first = asyncio.run(plan(PlanRequest(**args)))
        self.assertEqual(first["template_budget"]["unknown_count"], 2)
        self.assertEqual(
            {r["required_ul"] for r in first["template_budget"]["rows"]}, {10}
        )
        result = asyncio.run(
            plan(
                PlanRequest(
                    **args,
                    template_available_ul={
                        "fixture:SAMPLE-00001": 9,
                        "fixture:SAMPLE-00002": 10,
                    }
                )
            )
        )
        self.assertEqual(
            [r["status"] for r in result["template_budget"]["rows"]],
            ["insufficient", "enough"],
        )
        self.assertEqual(
            sum(r["well_count"] for r in result["template_budget"]["rows"]),
            sum(w["Type"] == "Sample" for w in result["layout"]),
        )
        self.assertTrue(result["template_budget"]["issues"])
        self.assertEqual(
            result["inputs"]["template_available_ul"]["fixture:SAMPLE-00001"], 9
        )


if __name__ == "__main__":
    unittest.main()
