import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FrontendRegressionTests(unittest.TestCase):
    def test_batch_detail_thumbnails_resolve_current_index_after_deletes(self):
        detail_js = (ROOT / "static" / "js" / "batch" / "detail.js").read_text(encoding="utf-8")
        self.assertIn("function _batchDetailIndexForCard(card)", detail_js)
        self.assertIn("function _batchDetailCardForFilename(filename)", detail_js)
        self.assertIn("const curIdx = _batchDetailIndexForCard(div)", detail_js)
        self.assertIn("const card = _batchDetailCardForFilename(img)", detail_js)
        self.assertIn("card.style.pointerEvents = 'none'", detail_js)
        self.assertIn("function _syncBatchDetailImagesFromGrid()", detail_js)
        self.assertNotIn("() => _openBatchPreview(idx)", detail_js)
        self.assertNotIn("indexOf(div)", detail_js)
        self.assertNotIn("grid.children[idx]", detail_js)

    def test_formal_batch_ui_does_not_expose_turbo_or_over_sensitive_threshold(self):
        html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
        batch_js = (ROOT / "static" / "js" / "batch" / "core.js").read_text(encoding="utf-8")
        settings_js = (ROOT / "static" / "js" / "settings.js").read_text(encoding="utf-8")

        self.assertNotIn('<option value="turbo">', html)
        self.assertNotIn('min="1" max="15"', html)
        self.assertIn('min="4.5" max="15"', html)
        self.assertIn("Math.max(_BATCH_MIN_FORMAL_THRESHOLD, threshold)", batch_js)
        self.assertIn("['eco', 'fast'].includes($('settingSpeedMode').value)", settings_js)

    def test_completed_batch_ui_surfaces_quality_flags(self):
        core_js = (ROOT / "static" / "js" / "batch" / "core.js").read_text(encoding="utf-8")
        zones_js = (ROOT / "static" / "js" / "batch" / "zones.js").read_text(encoding="utf-8")
        detail_js = (ROOT / "static" / "js" / "batch" / "detail.js").read_text(encoding="utf-8")

        self.assertIn("qualityFlags: t.quality_flags || []", core_js)
        self.assertIn("batch-quality-hint", zones_js)
        self.assertIn("batch-detail-quality-warning", detail_js)


if __name__ == "__main__":
    unittest.main()
