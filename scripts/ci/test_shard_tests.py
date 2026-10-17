"""Shards cover every selected test file once, whole, balanced and stable."""

import json
import statistics
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import check_changed
from shard_tests import (
    DURATIONS,
    assign,
    durations_from_junit,
    expand_files,
    parse_shard,
    shard_files,
)


class ShardTests(unittest.TestCase):
    def test_every_file_lands_in_exactly_one_shard(self):
        files = [f"tests/test_{n}.py" for n in range(40)]
        durations = {f: float(n % 7 + 1) for n, f in enumerate(files)}
        shards = assign(files, 3, durations)
        flat = [f for shard in shards for f in shard]
        self.assertEqual(sorted(flat), sorted(files))
        self.assertEqual(len(flat), len(set(flat)))

    def test_shards_are_balanced_and_deterministic(self):
        durations = {f"tests/test_{n}.py": float(n) for n in range(1, 31)}
        shards = assign(list(durations), 3, durations)
        loads = [sum(durations[f] for f in shard) for shard in shards]
        self.assertLessEqual(max(loads) - min(loads), max(durations.values()))
        self.assertEqual(shards, assign(list(reversed(durations)), 3, durations))

    def test_an_unmeasured_file_weighs_the_median(self):
        durations = {"tests/test_a.py": 1.0, "tests/test_b.py": 9.0}
        shards = assign([*durations, "tests/test_new.py"], 2, durations)
        # The new file (5 s) joins the lighter shard, beside the 1 s file.
        self.assertIn(
            "tests/test_new.py", next(s for s in shards if "tests/test_a.py" in s)
        )

    def test_fewer_files_than_shards_leaves_empty_shards(self):
        self.assertEqual(
            assign(["tests/test_a.py"], 3, {}), [["tests/test_a.py"], [], []]
        )

    def test_the_suite_directory_expands_to_its_test_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tests" / "data").mkdir(parents=True)
            for name in ("test_a.py", "test_b.py", "conftest.py", "helpers.py"):
                (root / "tests" / name).write_text("")
            (root / "tests" / "data" / "sample.json").write_text("{}")
            self.assertEqual(
                expand_files(["tests/"], root), ["tests/test_a.py", "tests/test_b.py"]
            )
            self.assertEqual(
                expand_files(["tests/test_b.py"], root), ["tests/test_b.py"]
            )

    def test_the_real_suite_splits_into_three_close_shards(self):
        root = Path(__file__).resolve().parents[2]
        durations = json.loads(DURATIONS.read_text())
        shards = [shard_files(["tests/"], (k, 3), root) for k in (1, 2, 3)]
        self.assertEqual(
            sorted(f for s in shards for f in s), expand_files(["tests/"], root)
        )
        median = statistics.median(durations.values())
        loads = [sum(durations.get(f, median) for f in s) for s in shards]
        self.assertLess(max(loads) / min(loads), 1.25, loads)

    def test_shard_argument_is_validated(self):
        self.assertEqual(parse_shard("2/3"), (2, 3))
        for bad in ("0/3", "4/3", "1/0", "x"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_shard(bad)

    def test_durations_sum_per_file_from_junit(self):
        report = """<testsuites><testsuite>
          <testcase classname="tests.test_a" name="test_one" time="1.5"/>
          <testcase classname="tests.test_a.TestGroup" name="test_two" time="2.0"/>
          <testcase classname="tests.test_b" name="test_three" time="0.25"/>
          <testcase classname="tests.api.test_b.TestNested" name="test_four" time="1"/>
        </testsuite></testsuites>"""
        with tempfile.NamedTemporaryFile("w", suffix=".xml") as f:
            f.write(report)
            f.flush()
            self.assertEqual(
                durations_from_junit(Path(f.name)),
                {
                    "tests/api/test_b.py": 1.0,
                    "tests/test_a.py": 3.5,
                    "tests/test_b.py": 0.2,
                },
            )


class ShardedRunTests(unittest.TestCase):
    PLAN = {"backend": True, "frontend": False, "transport": False}

    def test_a_shard_runs_only_its_files(self):
        plan = {**self.PLAN, "pytest_paths": ["tests/test_a.py", "tests/test_b.py"]}
        with (
            patch.object(
                check_changed, "shard_files", return_value=["tests/test_b.py"]
            ),
            patch.object(check_changed.subprocess, "run") as run,
        ):
            check_changed.run_plan(plan, tests_only=True, shard=(2, 2))
        command = run.call_args.args[0]
        self.assertIn("tests/test_b.py", command)
        self.assertNotIn("tests/test_a.py", command)

    def test_the_shard_count_is_printed_for_github_output(self):
        plan = {
            **self.PLAN,
            "head": "abc",
            "pytest_paths": ["tests/test_a.py", "tests/test_b.py"],
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(plan, f)
            f.flush()
            argv = ["check_changed", "--plan", f.name, "--shard", "2/3", "--count-only"]
            with (
                patch("sys.argv", argv),
                patch.object(check_changed, "git_output", return_value=b"abc\n"),
                patch.object(
                    check_changed, "shard_files", return_value=["tests/test_b.py"]
                ),
                patch("builtins.print") as printed,
            ):
                check_changed.main()
        printed.assert_called_once_with("files=1")

    def test_an_empty_shard_never_runs_the_whole_suite(self):
        plan = {**self.PLAN, "pytest_paths": ["tests/test_a.py"]}
        with (
            patch.object(check_changed, "shard_files", return_value=[]),
            patch.object(check_changed.subprocess, "run") as run,
        ):
            check_changed.run_plan(plan, tests_only=True, shard=(3, 3))
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
