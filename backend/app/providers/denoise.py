"""Server-side denoise stages for Cascade (Tickets 16 and 17).

`build_denoise_chain(tuning)` turns one session's `cascade.denoise` block
into the list of stages `orchestrator.audio_iter()` runs over every mic frame
before it reaches Deepgram -- the single choke point every frame passes
through. The list is empty when nothing is enabled, which is what makes the
default path cost literally nothing rather than "almost nothing".

Not a `Protocol`-based vendor boundary like `base.py`'s STT/Translation/TTS
(nothing here is a swappable vendor for anything else); `DenoiseStage` is a
`Protocol` for the same reason `base.py` uses one -- a test double only has
to satisfy the shape.

Three rules every stage in here obeys:

* **Same byte length out as in, whatever that length is.** The worklet sends
  960-byte / 30 ms frames (`cascade-pcm-processor.js`), but nothing in the
  pipeline enforces that, so no stage may assume it.
* **Never raise into the audio path.** A stage that throws would end the
  Deepgram stream mid-sentence. Any failure -- a missing optional package, a
  model that won't load, a malformed frame -- degrades that stage to
  passthrough for the rest of the session, records the reason in
  `_last_init_error` (which `/api/tuning/capabilities` turns into the
  "installed but unusable" hint) and logs exactly once.
* **Fixed chain order, cheapest first:** `noisereduce -> deepfilternet`.
  Document order is irrelevant; the panel lists the same two rows.

Demucs and DNS64 are deliberately absent: they are whole-file stages that
only `run_tuning_sweep.py` applies, before replay. Enabling them in a live
session is legal in the document (story AC 5.4) and inert here.
"""

import importlib.util
import logging
from collections.abc import Callable
from typing import Any, Final, NamedTuple, Protocol

from app.providers.deepgram_stt import SAMPLE_RATE
from app.tuning.schema import CascadeTuning, DeepFilterNetTuning

logger = logging.getLogger(__name__)

# Stage name (as the panel and `/api/tuning/capabilities` know it) -> the
# module whose importability decides it. DeepFilterNet imports as `df`;
# DNS64 is Facebook's `denoiser` package.
STAGE_MODULES: Final[dict[str, str]] = {
    "deepfilternet": "df",
    "noisereduce": "noisereduce",
    "demucs": "demucs",
    "dns64": "denoiser",
}

# How much preceding audio `NoisereduceStage` hands to `reduce_noise` per
# frame. `noisereduce` has no streaming API at all: it takes a signal and
# returns a denoised signal, so the only way to run it live is to re-process
# a rolling window and keep the newest frame's worth of the result. 480 ms is
# enough context for its spectral gating to estimate a noise profile without
# making the per-frame cost absurd.
_NR_CONTEXT_MS: Final = 480
_NR_CONTEXT_BYTES: Final = int(SAMPLE_RATE * (_NR_CONTEXT_MS / 1000)) * 2  # PCM16 mono

# DeepFilterNet's own framing: DFN3 is a 48 kHz model with a 960-sample FFT
# and a 480-sample (10 ms) hop, so one 30 ms worklet frame is exactly 3 hops.
_DFN_SAMPLE_RATE: Final = 48000
_DFN_HOP: Final = 480

# Stage name -> the failure its first real use hit (a missing optional
# package, DeepFilterNet's `init_df()` failing to fetch weights, a frame it
# could not parse). Read by `/api/tuning/capabilities`: installed-but-
# unusable needs a different hint from not-installed. Module-level and never
# cleared, because a load failure is a property of the process rather than of
# one session.
_last_init_error: dict[str, str] = {}

# Messages already logged in this process. These lines describe a *config*
# ("you enabled something this path ignores"), so the two-hundredth copy adds
# nothing; per-process rather than per-session for the same reason.
_logged_once: set[str] = set()


def _log_once(key: str, message: str, *args: Any) -> None:
    if key in _logged_once:
        return
    _logged_once.add(key)
    logger.info(message, *args)


def _record_degradation(name: str, exc: Exception) -> None:
    """What every stage does on the way to passthrough: leave a reason
    `/api/tuning/capabilities` can turn into "installed, but it will not
    run", and warn once. Once, because the caller sets its own degraded flag
    and stops trying -- a stage that logged per frame would emit 33 lines a
    second for the rest of the session."""
    _last_init_error[name] = f"{type(exc).__name__}: {exc}"
    logger.warning(
        "%s stage unavailable (%r) -- passing audio through unprocessed "
        "for the rest of this session",
        name,
        exc,
    )


class DenoiseStage(Protocol):
    """One step of the live chain. PCM16 mono 16 kHz in, the same number of
    bytes out. `name` is what `run_tuning_sweep.py` reports for the row."""

    name: str

    def process(self, frame: bytes) -> bytes: ...

    def reset(self) -> None:
        """Drop any carried-over audio context. Called on the stages of a
        chain that is being replaced, so a mid-session Apply can't leak one
        config's context into the next one's output."""
        ...


class NoopStage:
    """Identity: the trivial `DenoiseStage` implementation, used by the tests
    to exercise the Protocol without a real denoiser. Nothing in `app/` builds
    one -- a stage that loses its library degrades in place (`_degraded`) and
    returns the frame untouched rather than being swapped for this."""

    name = "noop"

    def process(self, frame: bytes) -> bytes:
        return frame

    def reset(self) -> None:
        pass


def _load_noisereduce() -> tuple[Any, Any]:
    """The `bench` extra, imported on first use rather than at module import:
    `noisereduce` pulls in scipy/librosa, and a server whose panel never
    turns the stage on should not pay for that at startup. Also the seam the
    degradation tests fail on purpose."""
    import noisereduce
    import numpy

    return noisereduce, numpy


class NoisereduceStage:
    """`noisereduce`'s spectral gating, run live over a rolling window.

    Per frame: append it to a `_NR_CONTEXT_MS` ring buffer, run
    `reduce_noise` over the whole buffer, and emit the last `len(frame)`
    bytes of the result. That adds **no algorithmic delay** (the frame comes
    out on the frame it went in) at the cost of re-processing the same
    context repeatedly -- a real CPU cost, measured by the tuning sweep's
    `addedLatencyMs` column rather than optimised here.

    The buffer starts full of silence, so the first frame of a session gets
    the same window shape as every later one instead of failing a transform
    that needs more samples than it has. The cost is a warm-up: for the first
    `_NR_CONTEXT_MS` the noise profile is estimated partly from that silence.
    """

    name = "noisereduce"

    def __init__(self, prop_decrease: float = 1.0, stationary: bool = False) -> None:
        self.prop_decrease = prop_decrease
        self.stationary = stationary
        self._buffer = bytearray(_NR_CONTEXT_BYTES)
        self._degraded = False
        self._warned_non_finite = False

    def process(self, frame: bytes) -> bytes:
        # An odd byte count isn't PCM16 at all: pass it through untouched
        # rather than degrading the whole session over one malformed frame.
        if self._degraded or len(frame) < 2 or len(frame) % 2:
            return frame
        try:
            noisereduce, numpy = _load_noisereduce()
            self._buffer += frame
            # A frame longer than the context window widens the window for
            # that frame; it can never be truncated, or the stage would
            # return fewer bytes than it was given.
            del self._buffer[: -max(_NR_CONTEXT_BYTES, len(frame))]
            samples = numpy.frombuffer(self._buffer, dtype="<i2").astype(numpy.float32)
            reduced = noisereduce.reduce_noise(
                y=samples,
                sr=SAMPLE_RATE,
                prop_decrease=self.prop_decrease,
                stationary=self.stationary,
            )
            tail = numpy.asarray(reduced, dtype=numpy.float32)[-(len(frame) // 2) :]
            finite = numpy.isfinite(tail)
            if not finite.all():
                if not finite.any():
                    # Nothing usable came back at all. Sanitising would emit
                    # a frame of silence where speech was; the audio that
                    # went in is a better answer than that.
                    self._warn_non_finite("frame passed through unprocessed")
                    return frame
                self._warn_non_finite("non-finite samples replaced")
                tail = numpy.nan_to_num(tail, nan=0.0, posinf=32767.0, neginf=-32768.0)
            return numpy.clip(numpy.rint(tail), -32768, 32767).astype("<i2").tobytes()
        except Exception as exc:  # noqa: BLE001 -- see the module docstring
            self._degrade(exc)
            return frame

    def reset(self) -> None:
        self._buffer = bytearray(_NR_CONTEXT_BYTES)

    def _warn_non_finite(self, action: str) -> None:
        """`noisereduce`'s non-stationary gate divides by a noise estimate it
        takes from the window itself (`spectralgate/nonstationary.py:70`), so
        a near-silent or DC-only window comes back as NaN. `numpy.clip`
        propagates NaN and casting it to int16 is undefined, so before this
        guard those frames reached Deepgram as garbage -- one clean clip
        scored 100% WER that way, silently.

        Not a `_degrade`: this is a property of *that* audio, usually a pause
        between utterances, so the next frame deserves the same denoising the
        last good one got. Once per session for the same reason
        `_record_degradation` logs once -- it can recur 33 times a second.
        """
        if self._warned_non_finite:
            return
        self._warned_non_finite = True
        logger.warning(
            "noisereduce returned non-finite samples (%s); further "
            "occurrences in this session are not logged",
            action,
        )

    def _degrade(self, exc: Exception) -> None:
        self._degraded = True
        _record_degradation(self.name, exc)


# `init_df()`'s `(model, df_state, suffix)`, loaded on the first frame of the
# first session that enables the stage and then kept for the life of the
# process: it reads a config, loads weights (downloading them once, into a
# user cache) and costs seconds. A second session must not pay that again.
_DF_MODEL: tuple[Any, Any, str] | None = None


class _DFRuntime(NamedTuple):
    """Everything `DeepFilterNetStage.process` needs from torch and
    DeepFilterNet, resolved once by `_load_deepfilternet()`.

    Naming the five operations is what keeps `process` free of imports and
    free of tensor code, so the buffering -- the part that is ours, and the
    part that is easy to get wrong -- can be tested in a default install
    where torch is not installed at all: lists of floats satisfy this shape
    just as well as tensors do.
    """

    # `n` samples of silence. Used for the priming that buys hop alignment.
    zeros: Callable[[int], Any]
    concat: Callable[[Any, Any], Any]
    # PCM16 16 kHz bytes -> 48 kHz samples (three per input sample).
    to_48k: Callable[[bytes], Any]
    # 48 kHz samples -> exactly `n` samples' worth of PCM16 16 kHz bytes.
    to_pcm16: Callable[[Any, int], bytes]
    # A whole number of 48 kHz hops, an attenuation limit in dB and a
    # post-filter beta -> the same number of samples, denoised.
    enhance: Callable[[Any, float, float], Any]


def _set_post_filter(model: Any, beta: float) -> None:
    """Put this session's post-filter strength in force on the shared model.

    DeepFilterNet3 reads `post_filter`/`post_filter_beta` off the model
    inside `forward` (`df/deepfilternet3.py:448-453`) and `enhance()` takes
    no post-filter argument at all -- `init_df(post_filter=True)` only seeds
    them from the model config at load time. Setting them per call is
    therefore the only way one cached model can serve sessions that chose
    different betas, and it is safe because `process()` is synchronous: no
    other session's frame can run between this and `enhance()`.

    Older DeepFilterNet models bake the post filter into their `Mask` module
    at construction and expose no such attribute. Say so once, run without
    it: an ignored knob is not worth failing a session over.
    """
    if not hasattr(model, "post_filter_beta"):
        _log_once(
            "deepfilternet:post_filter",
            "installed DeepFilterNet model has no runtime post-filter; "
            "postFilterBeta is ignored",
        )
        return
    model.post_filter = beta > 0
    model.post_filter_beta = beta


def _load_deepfilternet() -> _DFRuntime:
    """The `denoise` extra, imported on the stage's first frame.

    Never at module import (that would put torch in the live path of every
    session, installed or not) and never from `/api/tuning/capabilities`,
    which answers with `find_spec` alone: `init_df()` downloads and loads
    weights, and a poll must not pay for that. Also the seam the degradation
    tests fail on purpose.

    `import df` is fussier than it looks: DeepFilterNet 0.5.6 still imports
    `torchaudio.backend.common`, which torchaudio 2.9 deleted, so the extra
    pins `torchaudio < 2.9` (see `pyproject.toml`). With a newer torchaudio
    this raises `ModuleNotFoundError` and the stage degrades -- correctly,
    but permanently.
    """
    global _DF_MODEL

    import torch
    from df.enhance import enhance as df_enhance
    from df.enhance import init_df
    from torchaudio.functional import resample

    if _DF_MODEL is None:
        # `post_filter=True` builds the model *with* DeepFilterNet3's mask
        # post-filter present; whether it runs, and with which beta, is a
        # per-session decision made in `_set_post_filter`. `log_file=None`
        # stops DeepFilterNet writing an `enhance.log` into its own model
        # directory as a side effect of loading.
        _DF_MODEL = init_df(post_filter=True, log_file=None)

    model, df_state, _suffix = _DF_MODEL
    if (df_state.sr(), df_state.hop_size()) != (_DFN_SAMPLE_RATE, _DFN_HOP):
        # Everything below -- the resampling ratio, the hop-aligned ring,
        # the 10 ms delay -- is built on these two numbers. A model that
        # disagrees would be filtering a signal it cannot interpret, which
        # is worse than not filtering at all.
        raise ValueError(
            f"DeepFilterNet wants {df_state.sr()} Hz / {df_state.hop_size()}-sample "
            f"hops; this stage feeds it {_DFN_SAMPLE_RATE} Hz / {_DFN_HOP}"
        )

    def to_48k(frame: bytes) -> Any:
        # `bytearray` because `torch.frombuffer` warns on a read-only buffer.
        pcm = torch.frombuffer(bytearray(frame), dtype=torch.int16)
        return resample(pcm.to(torch.float32) / 32768.0, SAMPLE_RATE, _DFN_SAMPLE_RATE)

    def to_pcm16(samples: Any, count: int) -> bytes:
        at_16k = resample(samples, _DFN_SAMPLE_RATE, SAMPLE_RATE)[:count]
        if at_16k.numel() < count:
            # Only reachable if `resample` ever rounds a length down. The
            # same-bytes-out rule outranks the missing samples.
            at_16k = torch.nn.functional.pad(at_16k, (0, count - at_16k.numel()))
        # Same trap `NoisereduceStage` fell into: `clamp` propagates NaN and
        # the int16 cast of a NaN is undefined, so one bad sample out of the
        # model would be sent to Deepgram as noise rather than as silence.
        # DFN has not been seen to produce them; the cast is what makes it
        # not matter either way.
        at_16k = torch.nan_to_num(at_16k, nan=0.0, posinf=1.0, neginf=-1.0)
        pcm = (at_16k * 32768.0).round().clamp(-32768, 32767).to(torch.int16)
        return pcm.numpy().tobytes()

    def run(chunk: Any, attenuation_limit_db: float, post_filter_beta: float) -> Any:
        _set_post_filter(model, post_filter_beta)
        # `enhance` wants [C, T] and compensates its own STFT delay
        # (`pad=True`, its default). `atten_lim_db=0` means "no limit", i.e.
        # full attenuation, which is what the panel's 0 means too.
        enhanced = df_enhance(
            model, df_state, chunk.unsqueeze(0), atten_lim_db=attenuation_limit_db
        )
        return enhanced.squeeze(0)

    return _DFRuntime(
        zeros=torch.zeros,
        concat=lambda first, second: torch.cat((first, second)),
        to_48k=to_48k,
        to_pcm16=to_pcm16,
        enhance=run,
    )


class DeepFilterNetStage:
    """DeepFilterNet3, run over the live 16 kHz frame stream.

    DFN is a 48 kHz model with a 480-sample (10 ms) hop, so a frame has to
    be resampled up, cut into whole hops, and resampled back down. Frame
    sizes are not guaranteed (module docstring, rule 1), so the hops are
    carved out of a 48 kHz ring rather than assumed: each frame is appended,
    every whole hop then available is enhanced, and the remainder -- always
    under one hop -- waits for the next frame.

    **Algorithmic delay: one hop, 10 ms.** The output ring starts primed
    with one hop of silence, and that priming is exactly what makes "emit
    `len(frame)` bytes, whatever `len(frame)` is" always satisfiable given
    that the unprocessed remainder can be up to a hop. So the first 10 ms of
    a session is silence and everything after it is 10 ms late. That is the
    minimum any hop-aligned stage can manage, and a third of one worklet
    frame. DFN's own STFT delay is compensated inside `enhance()` and is not
    added on top of it.

    Measured on this repo's CPU-only wheels (8 threads, 30 ms frames):
    **11.8 ms per frame** steady state, so a real-time factor of 0.39 -- it
    keeps up, with the caveat that the *first* frame costs ~2.7 s while
    `init_df()` loads the weights, on the event loop. Frames queue up behind
    it rather than being lost (`audio_queue` is unbounded and this stage runs
    inside `audio_iter`), and every later session in the process reuses the
    cached model, which is most of why it is cached.

    Two limitations worth stating rather than discovering, neither fixable
    through `df`'s public API: `enhance()` resets the model's recurrent
    state on every call, so the network sees each chunk without the previous
    one's context; and `df_state`'s STFT buffers belong to the
    process-cached model, so two *concurrent* sessions running this stage
    interleave into one filter state. Both cost some quality on an
    experimental, off-by-default stage in a single-user lab app. Neither can
    raise into the audio path, which is the property that matters.
    """

    name = "deepfilternet"

    def __init__(self, attenuation_limit_db: float, post_filter_beta: float) -> None:
        # Deliberately no torch here: constructing a stage happens whenever
        # `build_denoise_chain` runs, including on a server where the extra
        # was never installed.
        self.attenuation_limit_db = attenuation_limit_db
        self.post_filter_beta = post_filter_beta
        self._runtime: _DFRuntime | None = None
        self._pending: Any = None  # 48 kHz samples not yet a whole hop
        self._ready: Any = None  # 48 kHz samples enhanced, not yet emitted
        self._degraded = False

    def process(self, frame: bytes) -> bytes:
        # An odd byte count isn't PCM16 at all: pass it through untouched
        # rather than degrading the whole session over one malformed frame.
        if self._degraded or len(frame) < 2 or len(frame) % 2:
            return frame
        try:
            runtime = self._runtime
            if runtime is None:
                runtime = self._runtime = _load_deepfilternet()
            if self._ready is None:
                self._pending = runtime.zeros(0)
                self._ready = runtime.zeros(_DFN_HOP)  # the 10 ms of delay

            self._pending = runtime.concat(self._pending, runtime.to_48k(frame))
            whole_hops = len(self._pending) - len(self._pending) % _DFN_HOP
            if whole_hops:
                enhanced = runtime.enhance(
                    self._pending[:whole_hops],
                    self.attenuation_limit_db,
                    self.post_filter_beta,
                )
                self._pending = self._pending[whole_hops:]
                self._ready = runtime.concat(self._ready, enhanced)

            samples = len(frame) // 2
            due = samples * (_DFN_SAMPLE_RATE // SAMPLE_RATE)
            out, self._ready = self._ready[:due], self._ready[due:]
            return runtime.to_pcm16(out, samples)
        except Exception as exc:  # noqa: BLE001 -- see the module docstring
            # Deliberately broad, and it covers the load as well as the
            # maths: weights that will not download, a torch build that will
            # not import, a frame the model chokes on. All of it costs the
            # audio nothing more than the denoising itself.
            self._degrade(exc)
            return frame

    def reset(self) -> None:
        """Drop the carried 48 kHz audio, re-priming the 10 ms delay on the
        next frame. The loaded model stays: it is process-level, and
        `df_state`'s own buffers are not resettable through `df`'s API."""
        self._pending = None
        self._ready = None

    def _degrade(self, exc: Exception) -> None:
        self._degraded = True
        _record_degradation(self.name, exc)


def _build_deepfilternet(tuning: DeepFilterNetTuning) -> DenoiseStage:
    return DeepFilterNetStage(tuning.attenuation_limit_db, tuning.post_filter_beta)


# The seam `build_denoise_chain` appends through. A module attribute rather
# than a direct call for two reasons: a test can stand a fake stage in
# without touching the chain, and setting it to `None` turns an enabled row
# back into "unavailable -- skipped" for a build that ships without the
# stage. Pointing at the real factory still costs an install nothing:
# `DeepFilterNetStage` imports torch on its first frame and nowhere
# else, so a server without `uv sync --extra denoise` degrades on the first
# frame instead of failing at import.
_deepfilternet_factory: Callable[[DeepFilterNetTuning], DenoiseStage] | None = (
    _build_deepfilternet
)


def stage_installed(name: str) -> bool:
    """Whether `name`'s package is importable. `find_spec` only, never an
    import: the panel polls `/api/tuning/capabilities`, and importing `df`
    (let alone calling `init_df()`) would make that poll slow and allocate
    models nobody asked for. Detection failures are the caller's to handle."""
    return importlib.util.find_spec(STAGE_MODULES[name]) is not None


def build_denoise_chain(tuning: CascadeTuning) -> list[DenoiseStage]:
    """The stages this config asks for, cheapest first.

    `[]` when nothing is enabled -- `audio_iter()` tests the list and skips
    the whole path, so the default configuration adds no per-frame work at
    all. Called at every point `_SessionTuning.current` changes identity, not
    per frame.
    """
    denoise = tuning.denoise
    chain: list[DenoiseStage] = []

    if denoise.noisereduce.enabled:
        chain.append(
            NoisereduceStage(
                prop_decrease=denoise.noisereduce.prop_decrease,
                stationary=denoise.noisereduce.stationary,
            )
        )

    if denoise.deepfilternet.enabled:
        if _deepfilternet_factory is None:
            _log_once("deepfilternet", "deepfilternet stage unavailable — skipped")
        else:
            chain.append(_deepfilternet_factory(denoise.deepfilternet))

    for name in ("demucs", "dns64"):
        if getattr(denoise.offline, name):
            _log_once(
                f"offline:{name}",
                "offline-only denoise stage %s ignored in the live path",
                name,
            )

    return chain
