# Which books count, and how content gets in

Work Order 7. Work Order 1 read the 5etools dump through
`TWENTY24_SOURCES = {"XPHB", "XDMG"}`. That hand-picked list was wrong the day it
was written — the 2024 Artificer lives in `EFA`, and Ravenloft adds an Artificer
subclass — and it gets wronger with every release. This document is the rule that
replaced it.

---

## 1. The allowlist is derived, not written down

`src/dnd2024/sources.py` builds the accepted source set from `books.json`
metadata:

```
accepted = XPHB itself
         + every book published on or after XPHB's own release date
           whose `group` is player-facing content
         - explicitly excluded groups
         - anything that looks like playtest material
```

| | |
|---|---|
| **cutoff** | XPHB's `published` date, read from the data (2024-09-17), not hardcoded |
| **player-facing groups** | `core`, `setting`, `setting-alt`, `supplement`, `supplement-alt` |
| **excluded groups** | `screen` (DM screens), `other` (errata/FAQ, e.g. Sage Advice), `homecraft` (merchandise — one of them is a crochet pattern book), `recipe`, `organized-play` |
| **unknown groups** | neither accepted nor silently dropped: reported under `unknown_groups_needing_review` so a new format gets a decision rather than a default |

XPHB is included explicitly because it is published *on* the cutoff, not after
it, and because it is the baseline the whole tree is built from.

**A future book needs no code change.** That is the acceptance criterion, and a
test asserts it: adding a 2027 setting book to `books.json` puts it in scope.

### Unearthed Arcana

This dump contains none. "It happens to be absent" is not a safeguard, so there
are three independent ones — any of them excludes a book:

- `group` in `ua`, `playtest`, `prerelease`, `unearthed-arcana`
- `source` matching `^(ua|uab|ptr|pt)…`
- `name` containing "Unearthed Arcana" or "playtest"

Every exclusion is reported by source code, so "no playtest content got in" is a
line in the report rather than an assumption.

## 2. Reprints: newest qualifying source wins

The Artificer subclasses are the case that forced the rule — Alchemist, Armorer,
Artillerist and Battle Smith each exist in TCE (2014), again in EFA (2024), and
as a hybrid whose `source` is the old book and whose `classSource` is the new
class. The rule is general, because with this many books newly in scope the same
pattern will recur for other classes.

For one identity (name + level + whatever context the category needs):

| tier | what it is | what happens |
|---|---|---|
| **qualifying** | `source` in the allowlist and `classSource` in it too | eligible; newest publication date wins |
| **hybrid** | `source` out of scope, `classSource` in scope (`TCE` / `EFA`) | used **only** when no qualifying version of that identity exists, and recorded by name in the report |
| **rejected** | neither in scope | never enters, at any stage |

So: the EFA Alchemist supersedes both the TCE Alchemist and the TCE/EFA hybrid.
Reanimator (`source: RHW`, `classSource: EFA`) has no earlier printing and is
kept on its own merits. A 2014-only feature that was never reprinted never
appears.

Ties break on source code so two runs of the same dump produce the same graph.

## 3. Conflicts are reported, never merged silently

Dedup resolves one identity printed several times. It cannot resolve two
*different* entries that share a name — there is no basis for preferring one.
`find_conflicts` looks for exactly that, in two shapes:

- **same name, different entry, different books** — the known risk is
  `optionalfeatures.json`, whose Artificer Infusion (`AI`) category already
  carries XPHB-tagged entries from the Work Order 1 extraction even though
  Artificer is not XPHB content
- **same name used by two categories from two books** — a feat and an optional
  feature colliding across books (within *one* book this is legitimate: the
  fighting styles are both)

Any conflict stops the merge. `--accept-conflicts` overrides it and the override
is written into the report, so an override cannot be mistaken for a clean run.

## 4. The fidelity gate

`scripts/sweep_sources.py` did not produce the Work Order 1 corpus, so it has to
prove it can reproduce it before it is allowed to add to it. Every run
re-extracts with the *old* two-book filter and diffs node ids against the
existing `data/input/graph.json`:

```
fidelity check against the Work Order 1 corpus: PASS (735 reproduced vs 735 baseline)
```

A dirty diff means this extractor is wrong, not that the data changed — so the
merge is refused. Without that gate a subtly different extractor would rewrite
735 existing nodes while appearing to "add Artificer".

## 5. Running it

The 5etools dump is **not** in this repository — only Work Order 1's extracted
output is — so the script takes a path to it:

```bash
python3 scripts/sweep_sources.py --dump /path/to/5etools/data           # dry run
python3 scripts/sweep_sources.py --dump /path/to/5etools/data --write   # merge
python3 scripts/build_all.py                                            # rebuild
(cd web && npm run sync-data && npm run build && npm test)
```

The dump needs `books.json`, `class/class-*.json`, `feats.json`,
`optionalfeatures.json` and `items-base.json`. A dry run writes
`data/output/source_allowlist.json` and `data/output/source_sweep_report.json`
and touches nothing else; the report lists every accepted and rejected book with
a reason, every reprint resolved, every hybrid kept, every conflict, and the
node ids a merge would add or remove.

## 6. What the pipeline already handles

Nothing downstream special-cases an empty zone, and `tests/test_new_content.py`
proves it by building a real graph with Artificer content injected: the zone
populates, `zone_status` flips to `populated`, each subclass becomes its own
sub-region, the half-caster spine it already had is unchanged, the point economy
picks up a baseline it previously had to skip, and the Work Order 5 separation
and depth-ordering guarantees still hold — with no code change.

That rehearsal found one real gap, now fixed: `artificer_infusion` had no entry
in `OPTIONAL_FEATURE_HOME`, so the first EFA infusion would have crashed the
build with a `KeyError`. Infusions now sit in the Artificer zone on the Wizard
boundary at depth 2, and an optional-feature category nobody has mapped yet lands
in the commons with a note in `meta.notes` rather than taking the build down.
