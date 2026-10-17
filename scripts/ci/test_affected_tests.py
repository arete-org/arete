"""Impact selection must include downstream behavior without importing the app."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from affected_tests import affected_tests
from check_changed import run_plan


class ImpactTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.write("src/arete/leaf.py", "raise RuntimeError('never import source')")
        self.write("src/arete/service.py", "def run():\n from . import leaf")
        self.write("tests/test_service.py", "from arete.service import run")
        self.write("tests/test_other.py", "def test_other(): pass")
        self.write("tests/test_architecture.py", "")
        self.write("tests/test_api.py", "")

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def select(self, *paths):
        return affected_tests(list(paths), self.root)[0]

    def test_transitive_and_local_relative_imports(self):
        self.assertEqual(
            self.select("src/arete/leaf.py"),
            [
                "tests/test_api.py",
                "tests/test_architecture.py",
                "tests/test_service.py",
            ],
        )

    def test_mock_targets_and_literal_dynamic_imports(self):
        self.write("tests/test_other.py", "target = 'arete.leaf.operation'")
        self.assertIn("tests/test_other.py", self.select("src/arete/leaf.py"))
        self.write("tests/test_other.py", "__import__('arete.leaf')")
        self.assertIn("tests/test_other.py", self.select("src/arete/leaf.py"))

    def test_shared_fixture_transitive_consumers_and_usefixtures(self):
        self.write(
            "tests/conftest.py",
            """
import pytest
@pytest.fixture
def resource():
    from arete import leaf
@pytest.fixture
def indirect(resource): pass
""",
        )
        self.write("tests/test_other.py", "def test_other(indirect): pass")
        self.assertIn("tests/test_other.py", self.select("src/arete/leaf.py"))
        self.write(
            "tests/test_other.py",
            "@pytest.mark.usefixtures('indirect')\ndef test_other(): pass",
        )
        self.assertIn("tests/test_other.py", self.select("src/arete/leaf.py"))
        self.write("tests/test_other.py", "def test_other(): pass")
        self.assertNotIn("tests/test_other.py", self.select("src/arete/leaf.py"))

    def test_autouse_fixture_dependency_impacts_every_test(self):
        self.write(
            "tests/conftest.py",
            "@pytest.fixture(autouse=True)\ndef offline():\n from arete import leaf",
        )
        self.assertIn("tests/test_other.py", self.select("src/arete/leaf.py"))

    def test_test_only_runs_changed_test_and_importing_tests(self):
        self.write("tests/test_other.py", "from tests.test_service import helper")
        self.assertEqual(
            self.select("tests/test_service.py"),
            ["tests/test_other.py", "tests/test_service.py"],
        )

    def test_each_unknown_or_shared_input_forces_full_suite(self):
        for path in (
            "tests/conftest.py",
            "tests/data/corpus.jsonl",
            "src/arete/deleted.py",
            "src/arete/dataio/db.py",
            "uv.lock",
            "scripts/ci/affected_tests.py",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.select("src/arete/leaf.py", path), ["tests/"])
        self.write("src/arete/uncovered.py", "")
        self.assertEqual(
            self.select("src/arete/leaf.py", "src/arete/uncovered.py"), ["tests/"]
        )

    def test_dynamic_import_or_nested_fixtures_force_full_suite(self):
        self.write("tests/test_other.py", "importlib.import_module(name)")
        self.assertEqual(self.select("src/arete/leaf.py"), ["tests/"])
        self.write("tests/test_other.py", "")
        self.write("tests/sub/conftest.py", "")
        self.assertEqual(self.select("src/arete/leaf.py"), ["tests/"])

    def test_unmapped_loader_alias_import_and_fixture_alias_fall_back(self):
        for code in (
            "runpy.run_path(path)",
            "from importlib import import_module as load; load(name)",
        ):
            self.write("tests/test_other.py", code)
            self.assertEqual(self.select("src/arete/leaf.py"), ["tests/"])
        self.write("tests/test_other.py", "")
        self.write(
            "tests/conftest.py", "@pytest.fixture(name='db')\ndef database(): pass"
        )
        self.assertEqual(self.select("src/arete/leaf.py"), ["tests/"])

    def test_invalid_python_fails_closed(self):
        self.write("src/arete/leaf.py", "def broken(")
        with self.assertRaises(SyntaxError):
            self.select("src/arete/leaf.py")

    def test_runner_uses_explicit_files_and_bounded_workers(self):
        with patch("check_changed.subprocess.run") as run:
            run_plan(
                {"backend": True, "pytest_paths": ["tests/test_other.py"]},
                tests_only=True,
            )
        command = run.call_args.args[0]
        self.assertIn("tests/test_other.py", command)
        self.assertNotIn("tests/", command)
        self.assertEqual(command[command.index("-n") + 1], "2")
        self.assertEqual(run.call_args.kwargs["timeout"], 1320)

    def test_empty_backend_plan_never_runs_all_tests_implicitly(self):
        with self.assertRaises(ValueError):
            run_plan({"backend": True, "pytest_paths": []}, tests_only=True)


if __name__ == "__main__":
    unittest.main()
