# Sarvam findings (measured 22 Nov 2026, live API, saaras:v4)

Test: 5 Malayalam sentences -> Sarvam TTS (ml-IN) -> mono 16 kHz Opus in Ogg (same shape as a WhatsApp voice note, `demo-samples/PTT-test-N.opus`) -> `POST /speech-to-text`.

| Input (Malayalam) | `mode=translate` result | Time |
|---|---|---|
| ഇത് ഒരു പരീക്ഷണമാണ് | "This is an experiment." | 313 ms |
| എനിക്ക് നാളെ രാവിലെ ആലപ്പുഴയിലേക്ക് പോകണം | "I need to go to Alappuzha tomorrow morning." | 236 ms |
| വള്ളം കളി കാണാൻ ഞങ്ങൾ വൈകുന്നേരം വരും | "We will come in the evening to watch the boat race." | 211 ms |
| ദയവായി ഈ സന്ദേശം അമ്മയ്ക്ക് അയച്ചു കൊടുക്കണം | "Please send this message to mother." | 226 ms |
| മഴ പെയ്യുന്നതുകൊണ്ട് ഇന്ന് യാത്ര ഒഴിവാക്കാം | "Let's avoid the trip today because it is raining." | 272 ms |

All five meanings correct. The voice was synthetic (Sarvam's own TTS), so this proves the format and pipeline, NOT accuracy on real human voices, background noise or dialects: still untested.

## What the API returns (important for the UI)
- `mode=translate` returns English only (`transcript`) plus `language_code`. It does NOT return the Malayalam.
- `mode=transcribe` (and `verbatim`) returns the exact Malayalam script: "എനിക്ക് നാളെ രാവിലെ ആലപ്പുഴയിലേക്ക് പോകണം."
- `mode=translit` returns romanised Malayalam: "Enikku naale raavile Alappuzhayilekku pokanam." (lets someone who cannot read Malayalam say it aloud)
- `mode=codemix` keeps English words in Latin script: "എനിക്ക് നാളെ രാവിലെ Alappuzha-യിലേക്ക് പോകണം."
- All take the same form fields (`file`, `model=saaras:v4`, `mode`, `language_code`), `audio/ogg` accepted.
- So the notch result card = three parallel calls on the same audio: transcribe (Malayalam script), translit (Roman), translate (English). Run them in parallel; if one fails, show the others.

Limits: REST clips under 30 s; the response has no confidence value; the language is a code (ml-IN), not a dialect.
