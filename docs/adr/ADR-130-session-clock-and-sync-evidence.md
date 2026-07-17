# ADR-130 — Session clock and synchronization evidence

Capture sessions retain every source clock, timebase, coverage interval and recorder discontinuity. A canonical session clock is mapped piecewise; no normalized media file becomes the timing authority. Synchronization uses a documented evidence cascade and returns `insufficient-evidence` instead of inventing precision.

Multiple anchors estimate offset and drift while guarding speech from unsafe stretch. Scratch audio may provide evidence without entering the final mix, and sources with unequal starts, ends or gaps remain valid only inside their measured coverage.
