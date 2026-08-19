"""The config fingerprint: `cfg:` + the first 8 hex digits of the sha256 of a
canonical JSON rendering of the mode-scoped tuning document.

This algorithm is a **cross-language contract**. The TypeScript half lives in
`frontend/src/pages/tuningConfig.ts` and both are pinned to the same expected
values by `shared/tuning-fingerprint-cases.json`, which both test suites read
byte-identically. If you change anything here -- a range, a step, a number
format -- you are changing that contract, and the fixture has to be
regenerated with the TS side re-verified against it.

The six steps, per the brief:

1. project the full `TuningConfig` to the active mode (`schemaVersion` and
   `mode` are *inside* the hash: the same knobs in different modes are
   different runs);
2. recursively drop every `None` -- `false`, `0`, `""` and `[]` are real
   values and stay;
3. clamp every numeric knob to its documented range and round it to its
   documented step;
4. serialise to canonical JSON: keys sorted, no whitespace, no ASCII
   escaping, integral numbers with no decimal point and everything else at
   most 2 decimal places;
5. sha256 of the UTF-8 bytes;
6. `"cfg:" + digest[:8]`.

Two details are where a silent TS/Python disagreement would actually come
from, so they are implemented explicitly rather than left to the language:

* **Rounding direction.** `math.floor(x / step + 0.5)` matches JavaScript's
  `Math.round` for negative halves too (`Math.round(-45.5) === -45`), where
  Python's built-in `round` would give -46 (and banker's rounding elsewhere).
* **Binary noise.** `0.35 / 0.05 * 0.05` is `0.35000000000000003`, whose
  `repr`/`String()` is 17 significant digits in *both* languages. Rounding
  the quantised value to 2 decimals collapses it back to the double nearest
  `0.35`, which both languages then render as `0.35`. Step quantisation
  guarantees at most 2 decimals, so this never rounds a value a user chose.
"""

import hashlib
import json
import math
from collections.abc import Mapping
from typing import Any, Final

from pydantic import BaseModel

from app.tuning.schema import TuningMode

# path -> (minimum, maximum, step). Paths are dotted camelCase keys of the
# *document* (identical in the full config and in a mode projection, since
# projection only drops the inactive mode's top-level block). Mirrors
# `KNOB_METADATA` in `tuningConfig.ts`.
_KNOB_RANGES: Final[dict[str, tuple[float, float, float]]] = {
    "client.rmsGate.thresholdDbfs": (-80, 0, 1),
    "client.rmsGate.holdMs": (0, 2000, 10),
    "client.rmsGate.attackMs": (0, 500, 1),
    "client.rmsGate.releaseMs": (0, 2000, 10),
    "client.rmsGate.attenuationDb": (0, 60, 1),
    "client.rnnoise.voiceProbThreshold": (0, 1, 0.05),
    "realtime.turnDetection.threshold": (0, 1, 0.05),
    "realtime.turnDetection.prefixPaddingMs": (0, 5000, 1),
    "realtime.turnDetection.silenceDurationMs": (0, 10000, 1),
    "cascade.deepgram.endpointingMs": (0, 5000, 1),
    "cascade.deepgram.utteranceEndMs": (1000, 5000, 1),
    "cascade.denoise.noisereduce.propDecrease": (0, 1, 0.05),
    "cascade.denoise.deepfilternet.attenuationLimitDb": (0, 100, 1),
    # Step 0.01, **not** the brief's 0.05: the brief's own documented default
    # for this knob is 0.02, which is not on a 0.05 grid, so quantising to
    # 0.05 would rewrite the default to 0 and hash a config nobody chose.
    # `tuningConfig.ts` reached the same conclusion independently; both sides
    # flagged it rather than taking it silently.
    "cascade.denoise.deepfilternet.postFilterBeta": (0, 1, 0.01),
}

_DECIMALS: Final = 2


def _as_document(config: BaseModel | Mapping[str, Any]) -> dict[str, Any]:
    """Accept either a parsed model or the raw wire dict. Raw dicts matter:
    a fabricated `schemaVersion: 2` case has to be hashable without being
    parseable."""
    if isinstance(config, BaseModel):
        return config.model_dump(by_alias=True, exclude_none=True)
    return dict(config)


def project_mode(
    config: BaseModel | Mapping[str, Any], mode: TuningMode
) -> dict[str, Any]:
    """Step 1: the full `TuningConfig` narrowed to what one mode actually
    runs -- `{schemaVersion, mode, client, <mode block>}`."""
    document = _as_document(config)
    return {
        "schemaVersion": document.get("schemaVersion"),
        "mode": mode,
        "client": document.get("client"),
        mode: document.get(mode),
    }


def _quantise(value: float, path: str) -> float:
    """Step 3: clamp to range, round to step, then round to 2 decimals.

    Clamped again after the step rounding because rounding up at the top of a
    range can overshoot it. A number with no documented range passes through
    untouched -- the schema has none, but a raw wire dict can carry anything,
    and `tuningConfig.ts`'s `quantise()` leaves those alone too.
    """
    bounds = _KNOB_RANGES.get(path)
    if bounds is None:
        return value
    minimum, maximum, step = bounds
    clamped = min(max(value, minimum), maximum)
    stepped = math.floor(clamped / step + 0.5) * step
    return round(min(max(stepped, minimum), maximum), _DECIMALS)


def _normalise_number(value: float, path: str) -> float | int:
    """Step 4's number rule, applied while walking so `json.dumps` can then
    emit the value verbatim: integral -> `int` (so `1`, never `1.0`),
    otherwise the quantised float, whose `repr` is the shortest round-trip
    decimal -- the same string JS's `String()` produces."""
    quantised = _quantise(value, path)
    if float(quantised).is_integer():
        return int(quantised)
    return quantised


def _walk(value: Any, path: str) -> Any:
    if isinstance(value, Mapping):
        return {
            key: _walk(item, f"{path}.{key}" if path else str(key))
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, (list, tuple)):
        return [_walk(item, path) for item in value if item is not None]
    # bool is a subclass of int; it must stay a JSON boolean.
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return _normalise_number(value, path)
    return value


def canonical_document(document: BaseModel | Mapping[str, Any]) -> dict[str, Any]:
    """Steps 2-3 as a dict: `None`s dropped, numbers clamped/quantised/
    normalised. Serving this from `/api/tuning/capabilities` means the
    published defaults are literally the document that gets hashed."""
    return _walk(_as_document(document), "")


def canonicalize(document: BaseModel | Mapping[str, Any]) -> str:
    """Steps 2-4: the exact string that gets hashed."""
    return json.dumps(
        canonical_document(document),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def fingerprint(config: BaseModel | Mapping[str, Any], mode: TuningMode) -> str:
    """The full six steps. `config` is a full `TuningConfig` (model or wire
    dict); `mode` picks the projection that gets hashed."""
    canonical = canonicalize(project_mode(config, mode))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"cfg:{digest[:8]}"
