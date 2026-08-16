"""The shared `TuningConfig` document: schema, effective defaults, curated
allow-lists and the config fingerprint.

One JSON document describes every audio/turn-taking/segmentation/denoise knob
in both modes, and is carried unchanged between the browser, this backend and
the benchmark harnesses. `fingerprint()` is what joins a measurement to the
configuration that produced it, so its algorithm is a cross-language contract
(mirrored in `frontend/src/pages/tuningConfig.ts`, pinned by
`shared/tuning-fingerprint-cases.json`).

Import direction inside this package, deliberately one-way:

    schema.py       pure pydantic, imports nothing from `app`
    fingerprint.py  -> schema.py
    allowlists.py   -> app.config
    defaults.py     -> schema.py, app.config, app.providers.*, app.api.realtime

`schema.py` stays free of `app` imports because the modules that own the
values it mirrors (`app.api.realtime`, `app.providers.deepgram_stt`) will
themselves import the schema in later tickets; keeping the dependency in one
direction is what stops that from becoming a circular import.
"""
