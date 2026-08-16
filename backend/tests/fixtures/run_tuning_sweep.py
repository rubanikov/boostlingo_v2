"""Ticket 09's Cascade tuning sweep: replays the noisy corpus through the real
STT path once per `TuningConfig`, and joins every measurement to that config's
fingerprint.

This is the Cascade half of the benchmark flow (`04-brief.md` section 6). The
Realtime half is `frontend/e2e/realtime-quality-capture.mjs --tuning` plus
`run_realtime_quality_report.py`; the two meet in COMPARISON.md section 7.

Run from `backend/` (module form so `app` imports resolve):

    uv run python -m tests.fixtures.run_tuning_sweep --config configs/a.json

    --config PATH        a TuningConfig or a cascade ModeTuningConfig (repeatable)
    --corpus PATH        noisy_manifest.json (default: tests/fixtures/noisy/)
    --out PATH           where rows are written (default: tests/fixtures/tuning_sweep.json)
    --only ID[,ID...]    restrict to these source item ids (repeatable)
    --conditions clean,babble,street,fan,white
    --snr 20,10,5
    --limit N            stop after N rows
    --yes                proceed past the row cap

Needs a live `DEEPGRAM_API_KEY`; without one it prints how to set it and exits
0, same posture as every other harness here (AGENTS.md).

Three things about this runner are deliberate, because a sweep is long:

* **It paces in real time.** `stt_replay` replays audio at 20 ms per chunk on
  purpose, so 273 rows is roughly an hour. Hence `MAX_ROWS_WITHOUT_CONFIRM`,
  the estimated wall-clock in the refusal, and `--limit`/`--only`/
  `--conditions`/`--snr`.
* **It resumes.** Every row is written as soon as it is measured, and a row
  already in `--out` for the same (fingerprint, item, condition, SNR) is not
  re-measured. An interrupted sweep is continued by re-running the same
  command; a row you want to re-measure has to be deleted from the file.
* **The `clean` row is in every run**, even when `--conditions` leaves it out
  (story AC 2.5). Without a clean baseline a noisy WER says nothing: a config
  can look good at 5 dB and still be worse than doing nothing at all.

`correctedWer` is filled only by a config asking for `transcriptCheck.mode:
"correct"` (ticket 14), which also needs an `OPENAI_API_KEY`; it is `null`
otherwise, and a null there means "not measured", never "no improvement". The
LLM judge is not run: judge acceptance is a Realtime-only number in section 7
(builder decision 2), so Cascade rows leave that column blank.
"""

import argparse
import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from app.config import settings
from app.providers.base import ProviderError
from app.tuning.fingerprint import fingerprint
from app.tuning.schema import CascadeModeTuning, TuningConfig
from tests.fixtures.make_noisy_corpus import CONDITIONS, MANIFEST_NAME, NOISY_DIR
from tests.fixtures.stt_replay import (
    TRAILING_SILENCE_S,
    WavFormatError,
    assert_wav_format,
    audio_duration_s,
    transcribe_wav_detailed,
)

FIXTURES_DIR: Final = Path(__file__).parent
DEFAULT_CORPUS: Final = NOISY_DIR / MANIFEST_NAME
DEFAULT_OUT: Final = FIXTURES_DIR / "tuning_sweep.json"

# A sweep of the full corpus against two configs is ~800 rows of real-time
# audio replay, i.e. most of a working day. Anything above this cap has to be
# asked for explicitly (`--yes`) or narrowed (`--limit`, `--only`,
# `--conditions`, `--snr`).
MAX_ROWS_WITHOUT_CONFIRM: Final = 200

_ALL_CONDITIONS: Final = ("clean", *CONDITIONS)
_FFMPEG_HINT: Final = "ffmpeg -i <original> -ar 16000 -ac 1 -sample_fmt s16 {path}"


@dataclass(frozen=True)
class SweepConfig:
    """One `--config` file, resolved: what to hash it as, and what to replay
    with."""

    fingerprint: str
    file: str
    tuning: CascadeModeTuning

    @property
    def offline_stages(self) -> list[str]:
        """Demucs/DNS64 are benchmark-only (the live path ignores them), so
        this runner is the only thing that honours them."""
        offline = self.tuning.cascade.denoise.offline
        return [name for name in ("demucs", "dns64") if getattr(offline, name)]


@dataclass(frozen=True)
class PlannedRow:
    """One measurement to take: a config against one corpus variant."""

    config: SweepConfig
    item: dict

    @property
    def key(self) -> tuple[str, str, str, int | None]:
        return (
            self.config.fingerprint,
            self.item["sourceItemId"],
            self.item["condition"],
            self.item["snrDb"],
        )


def _load_config(path: Path) -> SweepConfig | None:
    """Accepts either shape the panel can export: the full `TuningConfig`
    (both modes) or an already-projected cascade `ModeTuningConfig`. Both
    carry `client` + `cascade`, which is all `project_mode` reads, so the two
    hash identically."""
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("mode") == "realtime":
        print(
            f"SKIP  {path}: this is a realtime ModeTuningConfig, and this sweep is the "
            "Cascade half. The Realtime half is `npm run capture:realtime-quality -- "
            "--tuning <file>` (see COMPARISON.md section 7)."
        )
        return None

    parsed = (
        CascadeModeTuning.model_validate(document)
        if document.get("mode") == "cascade"
        else TuningConfig.model_validate(document)
    )
    return SweepConfig(
        fingerprint=fingerprint(parsed, "cascade"),
        file=str(path),
        tuning=CascadeModeTuning(
            schema_version=parsed.schema_version,
            client=parsed.client,
            cascade=parsed.cascade,
        ),
    )


def _select_items(items: list[dict], args: argparse.Namespace) -> list[dict]:
    """The corpus variants this run measures. `clean` is added back if
    `--conditions` dropped it: see the module docstring."""
    if "clean" not in args.conditions:
        print(
            "Adding the clean baseline back in: every run reports one "
            "`condition: clean, snrDb: null` row per item, so a noisy number "
            "always has something to be worse than (story AC 2.5)."
        )
        args.conditions = ["clean", *args.conditions]

    return [
        item
        for item in items
        if (not args.only or item["sourceItemId"] in args.only)
        and item["condition"] in args.conditions
        and (item["snrDb"] is None or item["snrDb"] in args.snr)
    ]


def _plan(configs: list[SweepConfig], items: list[dict]) -> list[PlannedRow]:
    """Item-outer, config-inner: a `--limit`ed or interrupted run then covers
    every config for the items it did reach, which is what makes a partial
    sweep comparable at all."""
    return [PlannedRow(config=config, item=item) for item in items for config in configs]


def _read_existing(out_path: Path) -> dict:
    if not out_path.exists():
        return {"configs": [], "rows": []}
    return json.loads(out_path.read_text(encoding="utf-8"))


def _row_key(row: dict) -> tuple[str, str, str, int | None]:
    return (row["fingerprint"], row["itemId"], row["condition"], row["snrDb"])


def _estimated_seconds(planned: Sequence[PlannedRow], corpus_dir: Path) -> float:
    """Replay is paced in real time, so the wall-clock is the audio's own
    duration plus the trailing silence Deepgram's endpointing needs. Files
    that aren't there cost nothing -- they become skip rows."""
    total = 0.0
    for row in planned:
        path = corpus_dir / row.item["audioFile"]
        if path.exists():
            total += audio_duration_s(path) + TRAILING_SILENCE_S
    return total


def _format_duration(seconds: float) -> str:
    hours, remainder = divmod(int(seconds), 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def _result_row(
    row: PlannedRow,
    *,
    status: str,
    wer: float | None = None,
    corrected_wer: float | None = None,
    added_latency_ms: float | None = None,
    provider_latency_ms: float | None = None,
    skip_reason: str | None = None,
) -> dict:
    return {
        "fingerprint": row.config.fingerprint,
        "itemId": row.item["sourceItemId"],
        "condition": row.item["condition"],
        "snrDb": row.item["snrDb"],
        "wer": wer,
        # Ticket 14's column: the WER after the transcript check rewrote the
        # transcript, and `null` when no check ran (see the module docstring).
        "correctedWer": corrected_wer,
        "addedLatencyMs": added_latency_ms,
        "providerLatencyMs": provider_latency_ms,
        "status": status,
        "skipReason": skip_reason,
    }


async def _measure(row: PlannedRow, audio_path: Path) -> dict:
    """One replay, or the reason there isn't one. A per-item problem is never
    fatal: the sweep records it and moves on (F16)."""
    if not audio_path.exists():
        print(f"SKIP  {row.item['id']}: missing audio file: {audio_path}")
        print("      regenerate the corpus with: uv run python -m tests.fixtures.make_noisy_corpus")
        print(f"      or convert a recording: {_FFMPEG_HINT.format(path=audio_path)}")
        return _result_row(row, status="skipped", skip_reason="missing audio file")
    try:
        assert_wav_format(audio_path)
    except WavFormatError as exc:
        print(f"SKIP  {exc}")
        print(f"      convert with: {_FFMPEG_HINT.format(path=audio_path)}")
        return _result_row(row, status="skipped", skip_reason="wrong wav format")

    try:
        result = await transcribe_wav_detailed(
            audio_path,
            row.item["sourceLang"],
            row.item["targetLang"],
            settings.deepgram_api_key,
            tuning=row.config.tuning,
            offline_stages=row.config.offline_stages,
            reference_text=row.item["referenceText"],
        )
    except ProviderError as exc:
        print(f"ERROR {row.item['id']}: {exc}")
        return _result_row(row, status="error", skip_reason=str(exc))

    corrected = "" if result.corrected_wer is None else f"corrected {result.corrected_wer:.1%}  "
    print(
        f"{row.config.fingerprint}  {row.item['id']:<34} WER {result.wer:.1%}  {corrected}"
        f"added {result.added_latency_ms:.1f}ms  provider {result.provider_latency_ms:.0f}ms"
    )
    return _result_row(
        row,
        status="ok",
        wer=result.wer,
        corrected_wer=result.corrected_wer,
        added_latency_ms=round(result.added_latency_ms, 1),
        provider_latency_ms=round(result.provider_latency_ms, 1),
    )


def _write(out_path: Path, configs: list[dict], rows: list[dict]) -> None:
    """Called after every row: a sweep runs for hours, and losing all of it to
    a dropped connection at row 300 is not an acceptable failure mode."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(UTC).isoformat(),
                "configs": configs,
                "rows": rows,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _merge_configs(existing: list[dict], configs: list[SweepConfig]) -> list[dict]:
    merged = list(existing)
    known = {entry["fingerprint"] for entry in merged}
    for config in configs:
        if config.fingerprint not in known:
            merged.append(
                {
                    "fingerprint": config.fingerprint,
                    "file": config.file,
                    "mode": "cascade",
                }
            )
            known.add(config.fingerprint)
    return merged


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values)


def _print_report(configs: list[SweepConfig], rows: list[dict]) -> None:
    """The per-fingerprint summary plus the paste-ready section 7 rows,
    following `run_realtime_quality_report.py`'s convention: print the rows a
    human pastes, not a whole rendered table."""
    print("\n=== tuning sweep ===")
    for config in configs:
        mine = [row for row in rows if row["fingerprint"] == config.fingerprint]
        measured = [row for row in mine if row["status"] == "ok"]
        counts = (
            f"{len(measured)} ok / {sum(1 for r in mine if r['status'] == 'skipped')} skipped / "
            f"{sum(1 for r in mine if r['status'] == 'error')} error"
        )
        if not measured:
            print(f"{config.fingerprint}  {config.file}  {counts}")
            continue
        print(
            f"{config.fingerprint}  {config.file}  {counts}  "
            f"mean WER {_mean([r['wer'] for r in measured]):.1%}  "
            f"added {_mean([r['addedLatencyMs'] for r in measured]):.1f}ms  "
            f"provider {_mean([r['providerLatencyMs'] for r in measured]):.0f}ms"
        )

    table = _table_rows(configs, rows)
    if not table:
        return
    print("\nCOMPARISON.md section 7 rows:")
    for line in table:
        print(line)


def _corrected_cell(cell: list[dict]) -> str:
    """The corrected-WER cell, over however many rows in this bucket actually
    had a check run -- its own `n`, because a bucket where only some rows were
    checked must not read as if all of them were."""
    scored = [row["correctedWer"] for row in cell if row["correctedWer"] is not None]
    return "--" if not scored else f"{_mean(scored):.1%} (n={len(scored)})"


def _table_rows(configs: list[SweepConfig], rows: list[dict]) -> list[str]:
    """One markdown row per (fingerprint, condition, SNR) aggregate, in
    section 7's column order. `judge acceptance` is always blank -- the judge
    is Realtime-only (builder decision 2)."""
    lines = []
    for config in configs:
        measured = [
            row
            for row in rows
            if row["fingerprint"] == config.fingerprint and row["status"] == "ok"
        ]
        buckets = sorted(
            {(row["condition"], row["snrDb"]) for row in measured},
            key=lambda bucket: (_ALL_CONDITIONS.index(bucket[0]), -(bucket[1] or 0)),
        )
        for condition, snr_db in buckets:
            cell = [
                row for row in measured if (row["condition"], row["snrDb"]) == (condition, snr_db)
            ]
            lines.append(
                f"| `{config.fingerprint}` | cascade | {condition} | "
                f"{'--' if snr_db is None else f'{snr_db} dB'} | "
                f"{_mean([row['wer'] for row in cell]):.1%} (n={len(cell)}) | "
                f"{_corrected_cell(cell)} | -- | "
                f"{_mean([row['addedLatencyMs'] for row in cell]):.1f} ms | "
                f"{_mean([row['providerLatencyMs'] for row in cell]):.0f} ms |"
            )
    return lines


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m tests.fixtures.run_tuning_sweep",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--config",
        action="append",
        required=True,
        type=Path,
        metavar="PATH",
        help="a TuningConfig or cascade ModeTuningConfig JSON file (repeatable)",
    )
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--only",
        action="append",
        metavar="ID[,ID...]",
        help="restrict to these source item ids (repeatable, comma-separated)",
    )
    parser.add_argument(
        "--conditions",
        default=",".join(_ALL_CONDITIONS),
        help=f"comma-separated subset of {','.join(_ALL_CONDITIONS)} (clean is always included)",
    )
    parser.add_argument("--snr", default="20,10,5", help="comma-separated SNRs in dB")
    parser.add_argument("--limit", type=int, help="stop after this many rows")
    parser.add_argument(
        "--yes",
        action="store_true",
        help=f"run more than {MAX_ROWS_WITHOUT_CONFIRM} rows without being asked",
    )
    args = parser.parse_args(argv)

    args.only = [
        item_id.strip()
        for entry in (args.only or [])
        for item_id in entry.split(",")
        if item_id.strip()
    ]
    args.conditions = [name.strip() for name in args.conditions.split(",") if name.strip()]
    unknown = [name for name in args.conditions if name not in _ALL_CONDITIONS]
    if unknown:
        parser.error(f"unknown condition(s) {unknown} -- pick from {','.join(_ALL_CONDITIONS)}")
    try:
        args.snr = [int(value) for value in args.snr.split(",") if value.strip()]
    except ValueError:
        parser.error(f"--snr must be comma-separated integers, got {args.snr!r}")
    return args


async def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)

    configs = [config for config in (_load_config(path) for path in args.config) if config]
    if not configs:
        print("No usable Cascade config given -- nothing to sweep; exiting cleanly, not an error.")
        return 0

    if not args.corpus.exists():
        print(
            f"No noisy corpus manifest at {args.corpus}.\n"
            "Generate it with `uv run python -m tests.fixtures.make_noisy_corpus` "
            "(tests/fixtures/noisy/SCRIPT.md explains what each condition is). "
            "Nothing to sweep; exiting cleanly, not an error."
        )
        return 0
    if not settings.deepgram_api_key:
        print(
            "Needs a live DEEPGRAM_API_KEY (this sweep replays audio through the real "
            "streaming API) -- see backend/.env. Nothing measured; exiting cleanly, not "
            "an error."
        )
        return 0

    corpus_dir = args.corpus.parent
    manifest: dict[str, Any] = json.loads(args.corpus.read_text(encoding="utf-8"))
    planned = _plan(configs, _select_items(manifest["items"], args))

    existing = _read_existing(args.out)
    rows: list[dict] = existing["rows"]
    done = {_row_key(row) for row in rows}
    already = [row for row in planned if row.key in done]
    planned = [row for row in planned if row.key not in done]
    if already:
        print(f"{len(already)} row(s) already in {args.out} -- skipping those (resume).")

    if args.limit is not None:
        planned = planned[: args.limit]
    if len(planned) > MAX_ROWS_WITHOUT_CONFIRM and not args.yes:
        estimate = _estimated_seconds(planned, corpus_dir)
        print(
            f"Refusing to start {len(planned)} rows unasked (the cap is "
            f"{MAX_ROWS_WITHOUT_CONFIRM}): replay is paced in real time, so this is an "
            f"estimated wall-clock of ~{_format_duration(estimate)}.\n"
            "Narrow it with --limit/--only/--conditions/--snr, or pass --yes to run it "
            "as asked. Rows already measured into --out are resumed, so a --limit'ed run "
            "can be continued."
        )
        return 1
    if not planned:
        print("Nothing left to measure.")
        _print_report(configs, rows)
        return 0

    config_entries = _merge_configs(existing["configs"], configs)
    for row in planned:
        rows.append(await _measure(row, corpus_dir / row.item["audioFile"]))
        _write(args.out, config_entries, rows)

    print(f"\nwrote {len(rows)} row(s) to {args.out}")
    _print_report(configs, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
