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


if __name__ == "__main__":
    unittest.main()
