"""Conservative, import-free test impact analysis for PRs.

Follow reverse Python imports (including local imports and dotted mock targets).
Shared fixture dependencies are attached to their consumers, not every test.
Unknown inputs and dynamic imports fall back to the full suite.
"""

import ast
import re
from pathlib import Path

MAX_PYTHON_FILES = 2_000
MAX_FILE_BYTES = 1_000_000
# These contracts inspect source or load scripts by filename, so Python imports
# alone cannot associate them with every module whose behavior they verify.
GUARDS = {
    "tests/test_architecture.py",
    "tests/test_api.py",
    "tests/test_athlete_sql_contract.py",
    "tests/test_agent_context_budget.py",
    "tests/test_arete_mcp.py",
}
SHARED = ("src/arete/dataio/",)
SHARED_FILES = {"src/arete/config.py", "src/arete/api/main.py"}
DOTTED_MODULE = re.compile(r"\barete(?:\.[A-Za-z_]\w*)+")


def module_name(path: str) -> str:
    name = path.removeprefix("src/").removesuffix(".py").replace("/", ".")
    return name.removesuffix(".__init__")


def references(tree: ast.AST, module: str, package: bool = False) -> set[str]:
    refs = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            refs.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = module.split(".") if package else module.split(".")[:-1]
                base = ".".join(parts[: len(parts) - node.level + 1] + [base]).rstrip(
                    "."
                )
            refs.add(base)
            refs.update(f"{base}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            refs.update(DOTTED_MODULE.findall(node.value))
    return refs


def dynamic_import(tree: ast.AST) -> bool:
    names = {"__import__", "import_module", "getfixturevalue"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name in names
            )
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "id", getattr(node.func, "attr", ""))
            if name in names and (
                not node.args or not isinstance(node.args[0], ast.Constant)
            ):
                return True
    return False


def affected_tests(paths: list[str], root: Path) -> tuple[list[str], str]:
    """Return pytest arguments and an auditable reason; ['tests/'] means full."""
    backend = [p for p in paths if p.startswith(("src/", "tests/"))]
    if not backend:
        return ["tests/"], "shared build, dependency or CI configuration"
    for path in backend:
        if (
            path.startswith(SHARED)
            or path in SHARED_FILES
            or not path.endswith(".py")
            or Path(path).name in {"conftest.py", "__init__.py"}
            or not (root / path).is_file()
            or (path.startswith("tests/") and not Path(path).name.startswith("test_"))
        ):
            return ["tests/"], f"shared, deleted or non-Python input: {path}"
    # A dependency/CI change mixed with a source change must not narrow its gate.
    from select_checks import select_checks

    if any("backend" in select_checks([p]) for p in paths if p not in backend):
        return ["tests/"], "shared build, dependency or CI configuration"

    files = sorted(
        p.relative_to(root).as_posix()
        for folder in (root / "src", root / "tests")
        for p in folder.rglob("*.py")
    )
    if len(files) > MAX_PYTHON_FILES:
        raise ValueError(f"Impact graph exceeds {MAX_PYTHON_FILES} Python files")
    trees = {}
    for path in files:
        if (root / path).stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"Impact graph input too large: {path}")
        trees[path] = ast.parse((root / path).read_text(), filename=path)
    if any(dynamic_import(tree) for tree in trees.values()):
        return ["tests/"], "non-literal dynamic import or fixture lookup"
    for path, tree in trees.items():
        if path in GUARDS:
            continue
        if any(
            isinstance(node, ast.Call)
            and getattr(node.func, "attr", "")
            in {"run_path", "run_module", "spec_from_file_location", "exec_module"}
            for node in ast.walk(tree)
        ):
            return ["tests/"], f"unmapped dynamic file loader: {path}"

    modules = {module_name(p): p for p in files}
    modules.update({Path(p).stem: p for p in files if p.startswith("tests/")})

    def resolve(refs: set[str]) -> set[str]:
        dependencies = set()
        for ref in refs:
            parts = ref.split(".")
            # Include package initializers and the longest matching module;
            # from package import module and attribute imports both resolve.
            for length in range(1, len(parts) + 1):
                if path := modules.get(".".join(parts[:length])):
                    dependencies.add(path)
        return dependencies

    graph = {
        p: resolve(references(tree, module_name(p), p.endswith("/__init__.py")))
        for p, tree in trees.items()
        if Path(p).name != "conftest.py"
    }
    # Nested conftests require pytest's directory-level fixture resolution.
    if any(p != "tests/conftest.py" and p.endswith("/conftest.py") for p in files):
        return ["tests/"], "nested fixture configuration"
    conftest = trees.get("tests/conftest.py", ast.Module(body=[], type_ignores=[]))
    if any(
        (isinstance(node, ast.Name) and node.id == "pytest_plugins")
        or (isinstance(node, ast.keyword) and node.arg == "name")
        for node in ast.walk(conftest)
    ):
        return ["tests/"], "fixture aliases or plugins"
    fixtures = {}
    autouse = set()
    common = set()
    for node in conftest.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            fixtures[node.name] = node
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and any(
                    kw.arg == "autouse"
                    and isinstance(kw.value, ast.Constant)
                    and kw.value.value
                    for kw in decorator.keywords
                ):
                    autouse.add(node.name)
        else:
            common.update(resolve(references(node, "tests.conftest")))

    def fixture_refs(tree: ast.AST) -> set[str]:
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.arg):
                names.add(node.arg)
            elif isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                names.add(node.value)
        return {f"fixture:{name}" for name in names if name in fixtures}

    for name, node in fixtures.items():
        graph[f"fixture:{name}"] = resolve(
            references(node, "tests.conftest")
        ) | fixture_refs(node)
    for path in list(graph):
        if path.startswith("tests/"):
            graph[path].update(
                common | fixture_refs(trees[path]) | {f"fixture:{n}" for n in autouse}
            )

    reverse: dict[str, set[str]] = {}
    for consumer, dependencies in graph.items():
        for dependency in dependencies:
            reverse.setdefault(dependency, set()).add(consumer)
    tests = set()
    for changed in backend:
        impacted = {changed}
        frontier = {changed}
        for _ in range(len(graph) + 1):
            following = {
                p for dependency in frontier for p in reverse.get(dependency, set())
            } - impacted
            if not following:
                break
            impacted.update(following)
            frontier = following
        else:
            raise AssertionError("Impact graph did not converge")
        consumers = {
            p
            for p in impacted
            if p.startswith("tests/") and Path(p).name.startswith("test_")
        }
        # Check each source independently: another covered edit cannot hide it.
        if changed.startswith("src/") and not consumers:
            return ["tests/"], f"no test consumer found: {changed}"
        tests.update(consumers)
    if any(p.startswith("src/") for p in backend):
        tests.update(p for p in GUARDS if (root / p).exists())
    return sorted(
        tests
    ), "reverse imports, shared fixture consumers and architecture/API guards"
