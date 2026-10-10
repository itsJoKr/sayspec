# 0.12.0

- Record the value of every text field, passwords included, so a recorded sign-in becomes a runnable test. Recordings are made with test accounts. An obscured field's `enterText` action carries `obscured: true`; the `redacted`, `redaction` and `length` fields are gone.
- An obscured field's value is still never used as a tap's text finder, since the screen shows only dots.

# 0.11.0

- Record text entry as an `enterText` action carrying the field's final value. It is emitted before the next touch, on focus change, on navigation, and on pause or stop, so typing, pasting, autofill and dictation are all captured, including a field that still has focus when a button is tapped.
- Withhold values from obscured fields, password keyboards and secret autofill hints (password, one-time code, card number, card security code). The event then carries `redacted`, the reason and the value length only.
- A field's value is no longer used as a tap's text finder when the field is sensitive.

# 0.10.0

- A SaySpec-launched app opens idle with a small draggable Record/Stop overlay; each Record/Stop cycle is one test, and the screen visible at Record time is its first evidence.
- Overlay taps are excluded from evidence and the overlay is hidden from evidence screenshots.
- The recorder polls the host while recording so desktop Pause/Stop commands arrive without further interaction.

# 0.9.0

- Initial public release.
- Record taps, drags, navigation, lifecycle events, and explicit markers.
- Capture widget identity, ranked Patrol finder candidates, screenshots, and monotonic timestamps.
- Align device events with the SaySpec desktop host using measured clock calibration.
- Send bounded, authenticated event batches to the local SaySpec capture session.
- Read and validate SaySpec-owned launch values through `initializeFromEnvironment`, keeping host configuration out of application code.
