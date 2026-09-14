"""Every Python snippet in the documentation parses.

Lives here rather than beside the other documentation guards because those are
Node tests, and this one needs an interpreter. `test:sdk-python` is the step
that has one — putting a check behind a runtime the rest of the suite does not
need is how a check stops running.

Syntax only. Many blocks are fragments that reference names the prose around
them defines, so importing or executing them would fail on code that is correct
for a reader.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

DOCS = Path(__file__).resolve().parents[3] / "docs" / "api"


def snippets() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for path in sorted([*DOCS.glob("*.md"), *(DOCS / "guides").glob("*.md")]):
        for index, code in enumerate(re.findall(r"```tab:python\n(.*?)```", path.read_text(), re.S), start=1):
            found.append((f"{path.relative_to(DOCS.parent.parent)}#{index}", code))
    return found


class DocsSnippetsTest(unittest.TestCase):
    def test_every_python_snippet_parses(self) -> None:
        blocks = snippets()
        self.assertGreaterEqual(len(blocks), 10, f"only {len(blocks)} Python snippets found; the extractor stopped working")
        broken = []
        for where, code in blocks:
            try:
                ast.parse(code)
            except SyntaxError as failure:
                broken.append(f"{where}: line {failure.lineno}: {failure.msg}")
        self.assertEqual(broken, [], "these documented Python snippets do not parse:\n  " + "\n  ".join(broken))

    def test_the_two_languages_are_offered_in_the_same_places(self) -> None:
        # A page that shows Python for one call and only TypeScript for the next
        # teaches the reader that their language is sometimes missing.
        for path in sorted([*DOCS.glob("*.md"), *(DOCS / "guides").glob("*.md")]):
            text = path.read_text()
            python = len(re.findall(r"```tab:python\n", text))
            typescript = len(re.findall(r"```tab:(?:typescript|ts)\n", text))
            self.assertEqual(
                python,
                typescript,
                f"{path.name} offers {python} Python tabs and {typescript} TypeScript ones",
            )


if __name__ == "__main__":
    unittest.main()
