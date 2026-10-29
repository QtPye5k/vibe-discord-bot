# OpenAI model configuration

Checked against official OpenAI documentation on **October 29, 2026**. One `OPENAI_API_KEY` supplies the configured API calls; actual model access, billing and limits depend on that key's project. No live credential or paid-model acceptance is established by offline tests.

| Purpose                                                    | Environment setting          | Current project default  |
| ---------------------------------------------------------- | ---------------------------- | ------------------------ |
| Text, tools and vision                                     | `OPENAI_MODEL`               | `gpt-5-mini`             |
| Ordinary conversational voice                              | `OPENAI_REALTIME_MODEL`      | `gpt-realtime-2.1`       |
| Spoken action receipts, `/speak` and pipeline replies      | `OPENAI_SPEECH_MODEL`        | `gpt-4o-mini-tts`        |
| Local voice transcription, including wake checks           | `LOCAL_WHISPER_MODEL`        | `Xenova/whisper-tiny.en` |
| File transcription and optional hosted voice transcription | `OPENAI_TRANSCRIPTION_MODEL` | `gpt-transcribe`         |
| Image generation                                           | `OPENAI_IMAGE_MODEL`         | `gpt-image-2.5-flare`    |
| Image editing                                              | `OPENAI_IMAGE_EDIT_MODEL`    | `gpt-image-2.5-sunburst` |
| Automatic sexual-content classification                    | `OPENAI_MODERATION_MODEL`    | `omni-moderation-latest` |

Defaults are defined in source and `.env.example`. Existing `.env` files are preserved; an explicit local override wins over a new source default. Restart after changing settings. Image generation and editing use separate model settings; file transcription follows OpenAI's [recorded-audio workflow](https://developers.openai.com/api/docs/guides/transcription).

The [moderation endpoint](https://developers.openai.com/api/docs/guides/moderation) accepts text and image inputs. Vibe uses sexual-category decisions for automatic deletion; sexual/minors is a text-only classification and this is not a CSAM detector. See [AUTOMATIC_MODERATION.md](AUTOMATIC_MODERATION.md) for scanning bounds and enabled effects.

`VOICE_RESPONSE_BACKEND=realtime` streams ordinary addressed replies through the existing Realtime WebSocket adapter. Action requests use the text model's guarded tools and synthesize their spoken receipts through the speech model. `pipeline` selects text generation followed by speech synthesis for conversational replies too. `OPENAI_SPEECH_VOICE=marin` supplies the single voice setting for both paths. The [official Realtime conversation guide](https://developers.openai.com/api/docs/guides/realtime-conversations) describes audio output and session events.

`VOICE_TRANSCRIPTION_BACKEND=local` runs bounded consented utterances through a quantized CPU Whisper worker on the host before checking the bot's name. The default tiny English model is a local model, uses no OpenAI key, and needs `pnpm voice:prepare` once per host to cache its files in `.cache/models`. Only addressed requests and explicitly requested AI summaries/translation text then use OpenAI; ambient audio is not uploaded for wake checks. `openai` instead sends each consented captured utterance, including wake checks, to `OPENAI_TRANSCRIPTION_MODEL`. Both paths require individual consent and a verified private transcript channel. Local codec/model tests do not establish a live Discord UDP voice session.

## Retirement dates to act on

- `gpt-image-1` shut down October 23, 2026; the project uses current image replacements.
- `gpt-5-mini` is scheduled to shut down December 11, 2026. Its documented replacement is `gpt-5.6-terra`; migration still needs cost/access review and behavior testing before changing this project's text default.
- `gpt-4o-mini-tts` is scheduled to shut down January 6, 2027. Ordinary voice already uses a Realtime adapter; action receipts, `/speak`, translation speech and explicit pipeline replies still use the Speech API. Those remaining calls need migration before shutdown. The documented replacement, `gpt-realtime-2.1-mini`, uses the Realtime API and cannot simply replace the model name at `/v1/audio/speech`. See the [official speech migration notice](https://developers.openai.com/api/docs/guides/text-to-speech).
- The Videos API and Sora 2 shut down September 24, 2026 with no listed replacement. OpenAI video generation is not implemented by pointing at that retired service.

Dates and replacements come from the [official deprecation schedule](https://developers.openai.com/api/docs/deprecations). Recheck it before deployment and upgrades. `pnpm run doctor` catches the retired image default and reports upcoming text/speech deadlines; `pnpm run doctor --live` performs read-only authentication/model-visibility checks after credentials are entered. Visibility does not prove a successful paid request or acceptable output quality.
