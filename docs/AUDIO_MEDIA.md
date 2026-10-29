# Audio and video processing

The media module adds six local actions backed by FFmpeg/FFprobe. Both executables must be on the deployment host's `PATH`; no extra account or API key is needed. This computer has both installed. Install them in a Linux container/host if these actions will be used there.

| Action            | Implemented behavior                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `media.info`      | Bounded stream metadata for WAV, MP3, FLAC, Ogg, MP4 and WebM containers.                                    |
| `audio.convert`   | Extract the first audio stream, trim, apply validated effects, and encode MP3, Opus/Ogg, 16-bit WAV or FLAC. |
| `video.convert`   | Trim, resize, compress, and optionally mute the first video stream; encode fragmented MP4/H.264 or WebM/VP9. |
| `video.thumbnail` | Extract one video frame as a PNG at a requested timestamp.                                                   |
| `audio.waveform`  | Render a requested bounded segment as a PNG waveform.                                                        |
| `media.subtitles` | Generate SRT or WebVTT from explicit ordered, non-overlapping timed transcript segments.                     |

Inputs are downloaded only from HTTPS Discord attachment URLs. Container signatures select a fixed demuxer, and both processes use a `pipe`-only [protocol whitelist](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options). User input cannot supply command names, arbitrary FFmpeg options, filter graphs, URLs, or filesystem paths. Child processes run without a shell, with hidden windows on Windows. Runtime code creates no temporary media files.

The optional `effects` list applies up to six ordered typed effects after volume: `equalizer` (20–20,000 Hz, ±12 dB, bounded octave width), `compressor` (threshold, ratio, attack, release and makeup), `highpass`, `lowpass`, `echo` and `tempo` (0.5–2). Every option has a strict numeric schema and maps to a fixed FFmpeg filter; no raw filter syntax is accepted. The voice module also uses this pipeline to decode approved compressed attachments/sources into bounded stereo PCM.

Limits are 8 MB input/output, two in-flight operations with immediate busy rejection, a 20-second overall probe-and-convert deadline, one decoder/encoder/filter thread, eight streams, eight audio channels, 192 kHz input audio, and 2,073,600 input video pixels. Output segments are at most 120 seconds, audio is resampled to 48 kHz stereo, and video output is at most 1,280 pixels wide and 24 fps. Metadata, chapters and embedded subtitles are removed. Output overflow terminates the subprocess instead of buffering more data. These are application bounds; deploy with container/host CPU and memory limits when a hard operating-system resource ceiling is required.

Pipe input requires streamable media. MP4 attachments should have a front-loaded `moov` header (`faststart`) or use fragmentation; files requiring backward seeks can fail with a clear error. Duration can be unknown for non-seekable sources, while conversion still stops at the requested segment limit. Unsupported codecs, malformed files, missing streams and out-of-range supported options fail without exposing subprocess stderr. Only the first selected audio/video stream is processed; other tracks are not preserved. Subtitle generation formats supplied timing data; transcription uses the separate AI transcription actions.

Tests generate actual WAV and MP4 fixtures, then decode converted MP3/Ogg/FLAC/WAV files, inspect compressed MP4/WebM output, verify muting, inspect PNG waveforms/thumbnails, and check format/options/concurrency/subtitle boundaries. FFmpeg-dependent tests skip only on machines without the required executables; the executable tests were run successfully on this Windows host.
