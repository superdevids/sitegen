[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/superdevids/sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/superdevids/sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# speed-home

A dependency-free reimplementation of the static site build described by
makefun-site 1.0.0's README (site-generator-speed-01-run-20261122).

`main.ts` reads `/input/cases.json` (a JSON array of `{id, input}`, each input a
site `{site, templates, files}`) and writes `/output/answers.json`: one output
tree per case, in order, mapping every written path to its text.

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`
outside a container.

It runs as-is on Node 22.18 or later (type stripping); no packages, no
dependencies, standard library only.

The build follows the reference's documented dialect: front matter grammar,
Markdown subset (own block and inline rules, not CommonMark), template language,
slug rule, permalink and collection ordering, and the build report.

Licensed under the MIT License; see LICENSE.
