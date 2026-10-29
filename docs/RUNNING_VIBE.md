# Running Vibe

`BOT_NAME=Vibe` controls the assistant identity and help text. `OPENAI_SPEECH_VOICE=marin` controls both streamed Realtime replies and fallback speech. One Discord bot token and one OpenAI API key serve the bot; local speech recognition needs no additional account or API key. Restart after editing `.env`.

- Mention the actual Discord bot tag anywhere in a message, for example `Hi @Vibe, can you help?`. A bare mention returns brief help. Typing feedback starts while an addressed request is pending and refreshes for longer requests.
- `/ask prompt:your question` provides a private response. Discord shows its native thinking state for the deferred slash interaction. Public mentions can request typed server actions using your actual permissions, with separate short-lived public history and no private preferences or account data.
- `/join` connects to your current voice channel. `/speak text:Hello` requests spoken output. Joining alone does not authorize listening to your speech.
- Each speaker who wants conversational voice replies runs `/consent replies:true`. Consent expires after ten minutes. Say **Vibe** to start an addressed request. Brief, related follow-ups such as **confirm** can omit the name during the configured follow-up window; unrelated conversation requires a new name trigger. `/revoke`, `/stop` and `/leave` are immediate controls. See [VOICE.md](VOICE.md).
- Personal DMs retain their existing opt-in requirement. Unconsented messages and the bot's own messages do not start AI or typing feedback.

The bot needs View Channel, Send Messages and Read Message History in a text channel. Threads require Send Messages in Threads. Voice also requires Connect/Speak. A slash interaction can be visible even where ordinary channel replies are unavailable, because its response uses a different Discord delivery path.

## Confirmations and natural requests

`CONFIRMATION_MODE=smart` executes ordinary authorized changes from an addressed request. Creating an event, sending an explicitly requested message or renaming the server therefore does not need another approval. Destructive and privileged changes retain one concrete preview; say **confirm**, **do it** or **go ahead** in the same conversation to approve it. Vibe uses current server names/IDs and reasonable defaults, asks one brief question when a required target is missing, and reports actual action outcomes. See [CONFIRMATIONS.md](CONFIRMATIONS.md) and [AI_CONVERSATIONS.md](AI_CONVERSATIONS.md).

`BOT_TIME_ZONE=America/New_York` supplies local scheduling time. `CONFIRMATION_MODE=always` restores a preview before every write. Permissions, server policies and consent checks apply in either mode.

## Voice preparation

Set up the dedicated private transcript text channel before joining voice. The default discovery name is `vibe-transcripts`; `VOICE_TRANSCRIPT_CHANNEL_ID` selects an exact channel. Vibe never falls back to a public channel. See [VOICE_TRANSCRIPTS.md](VOICE_TRANSCRIPTS.md) for the required permission overwrites.

The default `VOICE_TRANSCRIPTION_BACKEND=local` uses the CPU Whisper model `LOCAL_WHISPER_MODEL=Xenova/whisper-tiny.en`. `SETUP.cmd` and `setup.sh` prepare it after their offline checks; this step is skipped if voice is disabled or transcription explicitly uses OpenAI. To prepare after changing the model or using a manual installation, run:

```sh
pnpm voice:prepare
```

Preparation downloads model assets into this project's `.cache/models` and initializes the local worker. It does not log into Discord, call OpenAI or upload microphone audio. Normal local voice operation uses the prepared cache and fails with preparation guidance if the model is missing; it does not silently switch to remote transcription. See [LOCAL_TRANSCRIPTION.md](LOCAL_TRANSCRIPTION.md).

The Docker build downloads the default local model into the image and copies it into a cache owned by the unprivileged runtime user. The portable source ZIP excludes model weights; run the normal setup script on each destination host. A different `LOCAL_WHISPER_MODEL` needs matching prepared weights inside the destination's cache before voice can join.

`VOICE_TRANSCRIPTION_BACKEND=openai` explicitly selects `OPENAI_TRANSCRIPTION_MODEL` instead. In that mode, consented captured utterances are uploaded for transcription before the name check, which can incur charges even when Vibe does not answer.

The default `VOICE_RESPONSE_BACKEND=realtime` uses persistent, per-speaker `OPENAI_REALTIME_MODEL=gpt-realtime-2.1` sessions and streams Marin audio. Local recognition checks the name and follow-up context before the addressed text reaches OpenAI. Requests that need Discord actions use the permission-checked action planner and speak the resulting receipt. `VOICE_RESPONSE_BACKEND=pipeline` selects separate text generation and speech generation instead. Both response backends share AI access policies, daily allowances and concurrency limits. A private transcript channel does not make spoken replies private.

`VOICE_SILENCE_MS=450` sets the end-of-utterance delay. `VOICE_FOLLOW_UP_SECONDS=60` bounds same-speaker conversational attention after a reply. `VOICE_WAKE_WORDS=Vibe` lists accepted name triggers. Shorter silence can split speech that includes pauses; longer silence adds response delay.

## Slash command synchronization

Startup and `pnpm deploy:commands` use the same reconciliation code. They read Discord's actual registered definitions, compare names/options/contexts/localizations and repair drift. A local saved hash cannot suppress that check. Guild-only installation also removes old global commands; global installation removes obsolete guild shadows. Personal and Activity entry commands keep their required global contexts.

The voice controls are `/join`, `/consent`, `/speak`, `/stop`, `/leave` and `/revoke`. Obsolete voice/music/moderation command groups and incompatible `/ask question` definitions are removed during synchronization. A compatibility path accepts an already cached `/ask question` invocation while the client refreshes; new publication uses `/ask prompt` exclusively.

If Discord's picker temporarily still displays removed entries, dismiss and reopen it; reload Discord if needed. `pnpm deploy:commands` reconciles actual server state again. Do not re-add the obsolete command groups.

## Verification

Run `pnpm check` for type checking, offline tests, the production build, smoke checks and formatting. `pnpm run doctor --voice` checks the configured installation and voice dependencies. Each speaker still needs current consent and access to the private transcript channel for a conversational voice session.
