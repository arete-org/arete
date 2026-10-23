"""Exercise action-pin detection against real workflow text, not mocked YAML."""

import contextlib
import tempfile
import unittest
from pathlib import Path

from check_action_pins import find_unpinned_uses


class CheckActionPinsTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        self.directory = Path(directory)

    def write(self, text: str) -> Path:
        path = self.directory / "workflow.yml"
        path.write_text(text)
        return path

    def test_sha_pinned_action_passes(self):
        path = self.write(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\n"
        )
        self.assertEqual(find_unpinned_uses(path), [])

    def test_tag_pinned_action_fails(self):
        path = self.write(
            "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v5\n"
        )
        violations = find_unpinned_uses(path)
        self.assertEqual([line for line, _ in violations], [4])

    def test_local_and_docker_actions_are_out_of_scope(self):
        path = self.write(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - uses: ./.github/actions/local\n"
            "      - uses: docker://alpine:3.19\n"
        )
        self.assertEqual(find_unpinned_uses(path), [])

    def test_nested_action_without_leading_dash_is_checked(self):
        path = self.write(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - id: restore\n"
            "        uses: actions/cache/restore@v4\n"
        )
        violations = find_unpinned_uses(path)
        self.assertEqual([line for line, _ in violations], [5])


if __name__ == "__main__":
    unittest.main()
