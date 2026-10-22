"""Pin which pull requests must name a Linear ticket, and the message they get."""

import contextlib
import io
import os
import unittest
from unittest.mock import patch

from linear_reference import FAILURE, check, main


class LinearReferenceTests(unittest.TestCase):
    def test_linear_branch_or_body_reference_passes(self):
        for branch, body in (
            ("gregoire-petit/are-113-analytics-as-four-questions", ""),
            ("feature-x", "Closes ARE-124."),
            ("feature-x", "https://linear.app/arete-app/issue/are-93/title"),
            ("fix_ARE-7", ""),
        ):
            with self.subTest(branch=branch):
                self.assertIsNone(check(branch, "someone", body))

    def test_missing_or_lookalike_reference_fails_with_the_fix(self):
        for branch, body in (
            ("feature-x", ""),
            ("feature-x", "Related: SHARE-12, ARE-, linear ticket pending"),
            ("care-12-fix", ""),
        ):
            with self.subTest(branch=branch, body=body):
                self.assertEqual(check(branch, "someone", body), FAILURE)
        self.assertIn("rename the branch", FAILURE)
        self.assertIn("ARE-<n> to the body", FAILURE)

    def test_bots_and_openwiki_automation_are_exempt(self):
        for branch, author in (
            ("dependabot/npm_and_yarn/frontend/vite-7.1.2", "dependabot[bot]"),
            ("renovate/vite-7.x", "renovate[bot]"),
            ("openwiki/update", "github-actions[bot]"),
        ):
            with self.subTest(branch=branch):
                self.assertIsNone(check(branch, author, ""))
        # A person cannot opt out with a branch merely resembling a bot's.
        self.assertEqual(check("openwiki-notes", "someone", ""), FAILURE)

    def test_main_reports_a_workflow_error_and_exit_code(self):
        output = io.StringIO()
        values = {"BRANCH": "feature-x", "AUTHOR": "someone", "BODY": "no ticket"}
        with patch.dict(os.environ, values), contextlib.redirect_stdout(output):
            self.assertEqual(main(), 1)
        self.assertEqual(output.getvalue().strip(), f"::error::{FAILURE}")
        values["BODY"] = "Linear: ARE-124"
        with (
            patch.dict(os.environ, values),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
