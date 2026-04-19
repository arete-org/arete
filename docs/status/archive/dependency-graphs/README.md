# Dependency Graphs

These SVGs are generated snapshots of repo dependencies.

Keep them as generated reference material, not as the main architecture reading
path.

Current files:

- `backend-dependency-graph.svg`
- `web-dependency-graph.svg`
- `discord-bot-dependency-graph.svg`
- `all-dependency-graph.svg`

They can be regenerated from the repo root with:

```bash
pnpm exec depcruise packages/backend/src packages/backend/test --config .dependency-cruiser.js --output-type dot --output-to - | dot -Tsvg -o docs/status/archive/dependency-graphs/backend-dependency-graph.svg
pnpm exec depcruise packages/web/src --config .dependency-cruiser.js --output-type dot --output-to - | dot -Tsvg -o docs/status/archive/dependency-graphs/web-dependency-graph.svg
pnpm exec depcruise packages/discord-bot/src packages/discord-bot/test --config .dependency-cruiser.js --output-type dot --output-to - | dot -Kfdp -Tsvg -o docs/status/archive/dependency-graphs/discord-bot-dependency-graph.svg
pnpm exec depcruise packages/backend/src packages/backend/test packages/web/src packages/discord-bot/src packages/discord-bot/test packages/contracts/src packages/prompts/src --config .dependency-cruiser.js --output-type dot --output-to - | dot -Tsvg -o docs/status/archive/dependency-graphs/all-dependency-graph.svg
```

If package boundaries or major module layouts change, regenerate these in the same PR.
