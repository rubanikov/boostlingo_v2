"""Tickets 16 and 17: the server-side denoise chain (`app.providers.denoise`).

What this file pins:

* **Nothing enabled costs nothing.** `build_denoise_chain` returns `[]`, so
  `orchestrator.audio_iter()` skips the whole path (story AC 5.2's other
  half, asserted at the frame level in `test_orchestrator.py`).
* **A denoise stage never ends a session.** `noisereduce` lives in an
  optional extra, so "not installed" is the *normal* state of a default
  install: the stage has to degrade to passthrough with one log line, not
  raise into the audio path.
* **Offline stages are benchmark-only.** Selecting Demucs/DNS64 in a live
  session is legal in the document and inert in the pipeline.

The real libraries run only where their extras are installed (`uv run --with
noisereduce --with numpy pytest tests/test_denoise.py`, or `uv sync --extra
bench`; `--extra denoise` for torch and DeepFilterNet); those tests self-skip
otherwise rather than pretending a stub's arithmetic is evidence. Everything
that is *ours* -- the chain, the degradation rules, DeepFilterNet's
hop-aligned buffering -- is tested with no extra installed at all, against
the two seams the stages load through (`_load_noisereduce`,
`_load_deepfilternet`).
"""

import importlib.util
import logging
import random
import struct
import sys
import warnings
from collections.abc import Callable, Sequence
from typing import Any

import pytest

from app.providers import denoise
from app.providers.denoise import (
    DeepFilterNetStage,
    NoisereduceStage,
    NoopStage,
    build_denoise_chain,
)
from app.tuning.schema import CascadeTuning

_HAS_NOISEREDUCE = importlib.util.find_spec("noisereduce") is not None
_NEEDS_BENCH = "needs the `bench` extra: run `uv sync --extra bench` in backend/"
# numpy alone is enough for the non-finite tests below: they script
# `reduce_noise`'s return value, so they need the array type but not the
# library that produces it.
_HAS_NUMPY = importlib.util.find_spec("numpy") is not None
_NEEDS_NUMPY = "needs numpy: `uv sync --extra bench`, or `uv run --with numpy pytest`"
_HAS_DEEPFILTERNET = (
    importlib.util.find_spec("df") is not None
    and importlib.util.find_spec("torch") is not None
    and importlib.util.find_spec("torchaudio") is not None
)
_NEEDS_DENOISE = "needs the `denoise` extra: run `uv sync --extra denoise` in backend/"


def _cascade(**denoise_block: object) -> CascadeTuning:
    """A `CascadeTuning` carrying only the denoise knobs a test cares about
    (wire keys, as the panel sends them)."""
    return CascadeTuning.model_validate({"denoise": denoise_block})


class _FakeStage:
    """Stands in for whatever ticket 17's DeepFilterNet stage turns out to
    be: the chain only ever needs `name`/`process`/`reset`."""

    def __init__(self, tuning: object = None) -> None:
        self.name = "deepfilternet"
        self.tuning = tuning
        self.frames: list[bytes] = []
        self.resets = 0

    def process(self, frame: bytes) -> bytes:
        self.frames.append(frame)
        return frame

    def reset(self) -> None:
        self.resets += 1


@pytest.fixture(autouse=True)
def _no_stale_module_state() -> None:
    """`_last_init_error` and the once-per-process log guard both outlive a
    single session on purpose; they must not outlive a single test."""
    denoise._last_init_error.clear()
    denoise._logged_once.clear()


class TestBuildDenoiseChain:
    def test_nothing_enabled_builds_no_chain_at_all(self) -> None:
        """Zero cost when off: `audio_iter` skips an empty list entirely."""
        assert build_denoise_chain(CascadeTuning()) == []

    def test_noisereduce_is_constructed_with_the_configured_parameters(self) -> None:
        chain = build_denoise_chain(
            _cascade(noisereduce={"enabled": True, "propDecrease": 0.6, "stationary": True})
        )

        assert len(chain) == 1
        stage = chain[0]
        assert isinstance(stage, NoisereduceStage)
        assert stage.name == "noisereduce"
        assert stage.prop_decrease == 0.6
        assert stage.stationary is True

    def test_offline_stages_are_never_constructed_live_and_say_so_once(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Story AC 5.4: selectable in a benchmark config, inert in a live
        session. `run_tuning_sweep.py` is the only thing that honours them."""
        tuning = _cascade(offline={"demucs": True, "dns64": True})

        with caplog.at_level(logging.INFO, logger="app.providers.denoise"):
            assert build_denoise_chain(tuning) == []
            build_denoise_chain(tuning)  # a second Apply must not re-log

        assert [record.getMessage() for record in caplog.records] == [
            "offline-only denoise stage demucs ignored in the live path",
            "offline-only denoise stage dns64 ignored in the live path",
        ]

    def test_deepfilternet_is_skipped_with_one_log_when_the_seam_is_unset(
        self, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ticket 17 points the factory at the real stage, so this is now
        only the path of a build that deliberately unsets it."""
        monkeypatch.setattr(denoise, "_deepfilternet_factory", None)
        tuning = _cascade(deepfilternet={"enabled": True})

        with caplog.at_level(logging.INFO, logger="app.providers.denoise"):
            assert build_denoise_chain(tuning) == []
            build_denoise_chain(tuning)

        assert [record.getMessage() for record in caplog.records] == [
            "deepfilternet stage unavailable — skipped"
        ]

    def test_the_deepfilternet_factory_seam_is_handed_its_own_tuning_block(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What ticket 17 plugs into: a callable taking the
        `DeepFilterNetTuning` block and returning a `DenoiseStage`."""
        monkeypatch.setattr(denoise, "_deepfilternet_factory", _FakeStage)
        tuning = _cascade(deepfilternet={"enabled": True, "attenuationLimitDb": 20})

        chain = build_denoise_chain(tuning)

        assert [stage.name for stage in chain] == ["deepfilternet"]
        assert chain[0].tuning == tuning.denoise.deepfilternet

    def test_the_chain_runs_cheapest_first(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Fixed order, not document order: noisereduce -> deepfilternet."""
        monkeypatch.setattr(denoise, "_deepfilternet_factory", _FakeStage)

        chain = build_denoise_chain(
            _cascade(
                deepfilternet={"enabled": True},
                noisereduce={"enabled": True},
                offline={"demucs": True},
            )
        )

        assert [stage.name for stage in chain] == ["noisereduce", "deepfilternet"]


class TestNoopStage:
    @pytest.mark.parametrize("size", [0, 1, 2, 100, 960, 4096])
    def test_arbitrary_frame_lengths_come_back_byte_for_byte(self, size: int) -> None:
        """Nothing enforces the worklet's 960-byte frame, so no stage may
        assume it -- `process` returns the same number of bytes it was
        given, whatever that number is."""
        stage = NoopStage()
        frame = bytes(range(256)) * (size // 256) + bytes(range(size % 256))

        processed = stage.process(frame)

        assert processed == frame
        assert len(processed) == len(frame)

    def test_reset_is_a_no_op_it_can_be_called_at_any_time(self) -> None:
        stage = NoopStage()
        stage.reset()

        assert stage.process(b"\x01\x02") == b"\x01\x02"


class TestNoisereduceDegradation:
    """The path a default install actually takes: the extra is not there."""

    def test_a_missing_package_degrades_to_passthrough_and_logs_once(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        def _no_package() -> tuple[object, object]:
            raise ImportError("No module named 'noisereduce'")

        monkeypatch.setattr(denoise, "_load_noisereduce", _no_package)
        stage = NoisereduceStage()

        with caplog.at_level(logging.WARNING, logger="app.providers.denoise"):
            first = stage.process(b"\x01\x02\x03\x04")
            second = stage.process(b"\x05\x06")

        assert (first, second) == (b"\x01\x02\x03\x04", b"\x05\x06")
        assert len(caplog.records) == 1
        assert "noisereduce" in caplog.records[0].getMessage()

    def test_the_failure_reaches_the_capabilities_endpoint_as_last_init_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Installed-but-unusable is a different hint from not-installed, and
        `/api/tuning/capabilities` reads it from exactly this dict."""

        def _no_package() -> tuple[object, object]:
            raise ImportError("No module named 'noisereduce'")

        monkeypatch.setattr(denoise, "_load_noisereduce", _no_package)

        NoisereduceStage().process(b"\x00\x00")

        assert "No module named 'noisereduce'" in denoise._last_init_error["noisereduce"]

    def test_a_failure_inside_the_processing_degrades_rather_than_killing_the_session(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A stage raising into `audio_iter()` would end the Deepgram stream
        mid-sentence. Whatever goes wrong, the frame goes through."""

        class _ExplodingNumpy:
            @staticmethod
            def frombuffer(*args: object, **kwargs: object) -> object:
                raise ValueError("bad input")

        monkeypatch.setattr(denoise, "_load_noisereduce", lambda: (object(), _ExplodingNumpy))
        stage = NoisereduceStage()

        with caplog.at_level(logging.WARNING, logger="app.providers.denoise"):
            assert stage.process(b"\x01\x02") == b"\x01\x02"
            assert stage.process(b"\x03\x04") == b"\x03\x04"

        assert len(caplog.records) == 1
        assert "bad input" in denoise._last_init_error["noisereduce"]


class _ScriptedNoisereduce:
    """`noisereduce` with a scripted last-`n` samples.

    Only the tail matters: `NoisereduceStage` emits the last `len(frame) //
    2` samples of whatever `reduce_noise` returns, so scripting exactly that
    slice says what the stage is about to try to cast.
    """

    def __init__(self, numpy: Any, tail: Sequence[float]) -> None:
        self._numpy = numpy
        self._tail = tail
        self.calls = 0

    def reduce_noise(self, *, y: Any, sr: int, prop_decrease: float, stationary: bool) -> Any:
        self.calls += 1
        reduced = self._numpy.array(y, dtype=self._numpy.float32)
        reduced[-len(self._tail) :] = self._numpy.asarray(self._tail, dtype=self._numpy.float32)
        return reduced


@pytest.mark.skipif(not _HAS_NUMPY, reason=_NEEDS_NUMPY)
class TestNoisereduceNonFiniteOutput:
    """Step 13's live-sweep defect. `noisereduce`'s non-stationary gate
    divides by a noise estimate it takes from the window itself
    (`spectralgate/nonstationary.py:70`), so a near-silent or DC-only window
    comes back as NaN -- and `numpy.clip` propagates NaN, so the float ->
    int16 cast emitted whatever the platform felt like. One clean clip
    scored 100% WER at Deepgram that way, which is worse than not denoising
    at all and, unlike a raised exception, silent.
    """

    @pytest.fixture
    def numpy(self) -> Any:
        import numpy

        return numpy

    def _stage(
        self, monkeypatch: pytest.MonkeyPatch, numpy: Any, tail: Sequence[float]
    ) -> tuple[NoisereduceStage, _ScriptedNoisereduce]:
        library = _ScriptedNoisereduce(numpy, tail)
        monkeypatch.setattr(denoise, "_load_noisereduce", lambda: (library, numpy))
        return NoisereduceStage(), library

    def test_nan_and_inf_samples_are_sanitised_instead_of_cast_as_garbage(
        self, monkeypatch: pytest.MonkeyPatch, numpy: Any
    ) -> None:
        """NaN -> silence, +-inf -> the ends of the int16 range. The frame
        keeps its length and every sample it carries is one Deepgram can
        interpret.

        Raising on `RuntimeWarning` is the point: casting NaN to int16 is
        undefined, and numpy says so through exactly that warning. Whatever
        this platform happens to produce for it is not a result.
        """
        infinity = float("inf")
        stage, _ = self._stage(
            monkeypatch, numpy, [1000.4, float("nan"), infinity, -infinity]
        )

        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            processed = stage.process(_pcm16([7, 8, 9, 10]))

        assert len(processed) == 8
        assert list(struct.unpack("<4h", processed)) == [1000, 0, 32767, -32768]

    def test_an_entirely_non_finite_slice_falls_back_to_the_frame_that_went_in(
        self, monkeypatch: pytest.MonkeyPatch, numpy: Any, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Nothing usable came back, so sanitising would emit silence where
        speech was. The original frame is a better answer than that."""
        nan = float("nan")
        stage, _ = self._stage(monkeypatch, numpy, [nan, nan, nan, nan])
        frame = _pcm16([7, 8, 9, 10])

        with caplog.at_level(logging.WARNING, logger="app.providers.denoise"):
            processed = [stage.process(frame) for _ in range(3)]

        assert processed == [frame, frame, frame]
        assert len(caplog.records) == 1  # once per session, not once per frame
        assert "noisereduce" in caplog.records[0].getMessage()

    def test_one_bad_frame_does_not_degrade_the_rest_of_the_session(
        self, monkeypatch: pytest.MonkeyPatch, numpy: Any
    ) -> None:
        """A NaN window is a property of *that* audio -- near-silence between
        utterances -- not of the stage. Degrading the session for it would
        turn a pause into "no denoising for the next ten minutes"."""
        tail = [float("nan")] * 4
        stage, library = self._stage(monkeypatch, numpy, tail)
        frame = _pcm16([7, 8, 9, 10])
        assert stage.process(frame) == frame

        tail[:] = [1.0, 2.0, 3.0, 4.0]
        assert struct.unpack("<4h", stage.process(frame)) == (1, 2, 3, 4)
        assert library.calls == 2
        assert denoise._last_init_error == {}  # not a stage failure

    def test_a_finite_result_is_cast_exactly_as_it_always_was(
        self, monkeypatch: pytest.MonkeyPatch, numpy: Any
    ) -> None:
        """The guard is not allowed to cost the normal path anything: still
        rounded to nearest and still clipped to the int16 range."""
        stage, _ = self._stage(monkeypatch, numpy, [0.4, -0.6, 40000.0, -40000.0])

        processed = stage.process(_pcm16([1, 2, 3, 4]))

        assert struct.unpack("<4h", processed) == (0, -1, 32767, -32768)


@pytest.mark.skipif(not _HAS_NOISEREDUCE, reason=_NEEDS_BENCH)
class TestNoisereduceRealProcessing:
    """The only tests that run the real library. `bench` is an optional
    extra, so a default install skips them rather than failing."""

    @pytest.mark.parametrize("size", [960, 100, 2, 16000])
    def test_the_output_is_the_same_byte_length_as_the_input(self, size: int) -> None:
        """Including a frame longer than the 480 ms context window, which the
        ring buffer has to widen for rather than truncate."""
        stage = NoisereduceStage(prop_decrease=0.9)
        frame = random.Random(size).randbytes(size)

        for _ in range(3):
            assert len(stage.process(frame)) == size
        assert denoise._last_init_error == {}

    def test_reset_drops_the_context_a_previous_config_left_behind(self) -> None:
        stage = NoisereduceStage()
        frame = random.Random(1).randbytes(960)
        stage.process(frame)

        stage.reset()

        assert len(stage.process(frame)) == 960
        assert denoise._last_init_error == {}


class _FakeDeepFilterNet:
    """torch and DeepFilterNet, in plain Python lists.

    `DeepFilterNetStage` reaches the libraries only through the
    `_DFRuntime` that `_load_deepfilternet()` returns, so standing in for
    that one object tests the buffering -- the part that is ours -- in a
    default install where torch is not installed at all.

    The resampling is nearest-neighbour (each 16 kHz sample three times, and
    every third sample on the way back), which is not what torchaudio does
    but is exact and invertible: with an identity `enhance`, whatever comes
    out is what went in, one hop later. That is what makes the 10 ms of
    algorithmic delay assertable rather than merely documented.
    """

    def __init__(self, enhance: Callable[[list[int]], list[int]] | None = None) -> None:
        self.chunks: list[list[int]] = []
        self.parameters: list[tuple[float, float]] = []
        self._enhance = enhance or (lambda chunk: chunk)

    def runtime(self) -> denoise._DFRuntime:
        return denoise._DFRuntime(
            zeros=lambda count: [0] * count,
            concat=lambda first, second: list(first) + list(second),
            to_48k=self._to_48k,
            to_pcm16=self._to_pcm16,
            enhance=self._run,
        )

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(denoise, "_load_deepfilternet", self.runtime)

    @staticmethod
    def _to_48k(frame: bytes) -> list[int]:
        samples = struct.unpack(f"<{len(frame) // 2}h", frame)
        return [sample for sample in samples for _ in range(3)]

    @staticmethod
    def _to_pcm16(samples: Sequence[int], count: int) -> bytes:
        at_16k = list(samples[::3])[:count]
        at_16k += [0] * (count - len(at_16k))
        return struct.pack(f"<{count}h", *at_16k)

    def _run(
        self, chunk: list[int], attenuation_limit_db: float, post_filter_beta: float
    ) -> list[int]:
        self.chunks.append(list(chunk))
        self.parameters.append((attenuation_limit_db, post_filter_beta))
        return self._enhance(chunk)


def _pcm16(samples: range | Sequence[int]) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


class TestDeepFilterNetWiring:
    def test_the_module_default_factory_is_the_real_stage(self) -> None:
        """Ticket 16 shipped the seam empty. Filling it here is what turns
        the panel row live once `uv sync --extra denoise` has been run --
        and it costs a default install nothing, because the stage imports
        torch on its first frame, not at construction."""
        chain = build_denoise_chain(
            _cascade(
                noisereduce={"enabled": True},
                deepfilternet={
                    "enabled": True,
                    "attenuationLimitDb": 12,
                    "postFilterBeta": 0.25,
                },
            )
        )

        assert [stage.name for stage in chain] == ["noisereduce", "deepfilternet"]
        stage = chain[1]
        assert isinstance(stage, DeepFilterNetStage)
        assert (stage.attenuation_limit_db, stage.post_filter_beta) == (12, 0.25)

    def test_constructing_the_stage_does_not_import_torch(self) -> None:
        """The whole reason `denoise` is an optional extra: a server that
        never enables the stage -- and a server that enables it without the
        extra installed -- must not pay for, or fail on, importing torch."""
        already_imported = "torch" in sys.modules

        build_denoise_chain(_cascade(deepfilternet={"enabled": True}))

        assert ("torch" in sys.modules) is already_imported


class TestDeepFilterNetBuffering:
    """The 48 kHz ring: DFN's 10 ms hop against frames of any size."""

    @pytest.mark.parametrize("size", [960, 2, 100, 1922, 4096])
    def test_the_output_is_the_same_byte_length_as_the_input(
        self, size: int, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _FakeDeepFilterNet().install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)
        frame = random.Random(size).randbytes(size)

        for _ in range(8):
            assert len(stage.process(frame)) == size
        assert denoise._last_init_error == {}

    def test_the_stream_comes_back_intact_exactly_one_hop_late(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The documented algorithmic delay, asserted: one 480-sample hop at
        48 kHz is 160 samples at 16 kHz, so the first 10 ms of the session is
        silence and every sample after it arrives 10 ms late."""
        _FakeDeepFilterNet().install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)

        first = stage.process(_pcm16(range(1, 481)))
        second = stage.process(_pcm16(range(481, 961)))

        assert first == _pcm16([0] * 160 + list(range(1, 321)))
        assert second == _pcm16(range(321, 801))

    def test_only_whole_hops_are_enhanced_and_the_remainder_is_carried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 100-byte frame is 150 samples at 48 kHz -- less than a hop, and
        never a whole number of them. The model still only ever sees whole
        hops, which is the point of the ring."""
        library = _FakeDeepFilterNet()
        library.install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)

        for _ in range(9):
            assert len(stage.process(bytes(100))) == 100

        assert [len(chunk) for chunk in library.chunks] == [480, 480]

    def test_the_configured_parameters_are_what_reach_the_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        library = _FakeDeepFilterNet()
        library.install(monkeypatch)

        DeepFilterNetStage(12.0, 0.25).process(bytes(960))

        assert library.parameters == [(12.0, 0.25)]

    def test_reset_drops_the_carried_audio_and_re_primes_the_delay(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A mid-session Apply rebuilds the chain and resets the outgoing
        stages; the next config must not inherit half a hop of the previous
        one's audio."""
        _FakeDeepFilterNet().install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)
        stage.process(_pcm16(range(1, 481)))

        stage.reset()

        assert stage.process(_pcm16(range(1, 481))) == _pcm16(
            [0] * 160 + list(range(1, 321))
        )

    def test_an_odd_byte_count_is_not_pcm16_and_passes_straight_through(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        library = _FakeDeepFilterNet()
        library.install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)

        assert stage.process(b"\x01\x02\x03") == b"\x01\x02\x03"
        assert library.chunks == []
        assert denoise._last_init_error == {}


class TestDeepFilterNetDegradation:
    """F15: torch is installed but the model will not load. The stage has to
    become a no-op for the rest of the session, not end it."""

    def test_f15_a_model_that_will_not_load_degrades_to_passthrough(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        def _no_weights() -> denoise._DFRuntime:
            raise OSError("could not download DeepFilterNet3")

        monkeypatch.setattr(denoise, "_load_deepfilternet", _no_weights)
        stage = DeepFilterNetStage(30, 0.02)
        frame = _pcm16(range(1, 481))

        with caplog.at_level(logging.WARNING, logger="app.providers.denoise"):
            processed = [stage.process(frame) for _ in range(3)]

        assert processed == [frame, frame, frame]
        assert len(caplog.records) == 1  # once, not once per frame
        assert "deepfilternet" in caplog.records[0].getMessage()

    def test_f15_the_failure_is_what_capabilities_reads_as_the_hint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`installed: true` + `model weights unavailable` is a different
        hint from `installed: false`, and this dict is where the difference
        comes from (`api/tuning.py`)."""

        def _no_weights() -> denoise._DFRuntime:
            raise OSError("could not download DeepFilterNet3")

        monkeypatch.setattr(denoise, "_load_deepfilternet", _no_weights)

        DeepFilterNetStage(30, 0.02).process(bytes(960))

        assert denoise._last_init_error == {
            "deepfilternet": "OSError: could not download DeepFilterNet3"
        }

    def test_a_failure_mid_stream_degrades_rather_than_killing_the_session(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The load succeeded and frames were flowing; something in the
        model then threw. Deepgram's stream must not notice."""
        frames = 0

        def _fail_on_the_second_call(chunk: list[int]) -> list[int]:
            nonlocal frames
            frames += 1
            if frames > 1:
                raise RuntimeError("shape mismatch")
            return chunk

        _FakeDeepFilterNet(enhance=_fail_on_the_second_call).install(monkeypatch)
        stage = DeepFilterNetStage(30, 0.02)
        frame = _pcm16(range(1, 481))

        with caplog.at_level(logging.WARNING, logger="app.providers.denoise"):
            stage.process(frame)
            after = [stage.process(frame) for _ in range(3)]

        assert after == [frame, frame, frame]
        assert len(caplog.records) == 1
        assert "shape mismatch" in denoise._last_init_error["deepfilternet"]


@pytest.mark.skipif(not _HAS_DEEPFILTERNET, reason=_NEEDS_DENOISE)
class TestDeepFilterNetRealLibrary:
    """The only DeepFilterNet tests that load torch and the real weights.
    `denoise` is an optional extra, so a default install skips them."""

    def test_real_frames_come_back_the_same_length_and_nothing_degrades(self) -> None:
        stage = DeepFilterNetStage(30, 0.02)
        rng = random.Random(17)

        for _ in range(6):
            frame = _pcm16([rng.randint(-8000, 8000) for _ in range(480)])
            assert len(stage.process(frame)) == 960
        assert denoise._last_init_error == {}

    def test_a_non_finite_sample_leaves_the_cast_as_silence_not_as_garbage(self) -> None:
        """`to_pcm16`'s half of the guard `NoisereduceStage` carries: `clamp`
        propagates NaN and the int16 cast of NaN is undefined. The runtime is
        a torch closure, so this is the only place it can be exercised."""
        import torch

        runtime = denoise._load_deepfilternet()

        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            pcm = runtime.to_pcm16(torch.full((480,), float("nan")), 160)

        assert pcm == bytes(320)

    def test_a_frame_that_is_not_a_whole_number_of_hops_still_round_trips(self) -> None:
        stage = DeepFilterNetStage(12, 0.0)
        rng = random.Random(18)

        for _ in range(6):
            frame = _pcm16([rng.randint(-8000, 8000) for _ in range(101)])
            assert len(stage.process(frame)) == 202
        assert denoise._last_init_error == {}


class TestStageDetection:
    def test_every_capability_stage_maps_to_the_module_that_proves_it(self) -> None:
        """DeepFilterNet imports as `df`, DNS64 as `denoiser` -- the two
        places a plausible-looking guess would be wrong."""
        assert denoise.STAGE_MODULES == {
            "deepfilternet": "df",
            "noisereduce": "noisereduce",
            "demucs": "demucs",
            "dns64": "denoiser",
        }

    def test_installed_reports_what_is_importable_without_importing_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`find_spec`, never an import: `/api/tuning/capabilities` is polled
        by the panel and must not pay for loading a model."""
        assert denoise.stage_installed("noisereduce") is _HAS_NOISEREDUCE

        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: object())
        assert denoise.stage_installed("deepfilternet") is True

        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: None)
        assert denoise.stage_installed("deepfilternet") is False
