# Screenshare feasibility on 127.0.0.1

**Decision.** A dedicated video stream merits a one-sharer, one-viewer Windows field experiment. Keep screenshare outside the portable release until the source picker, capture lifecycle, voice quality and recovery have been verified on separate computers. The shipping app has no screenshare control or capture permission for this prototype.

## Capture and encoding

The isolated Electron 40.5.0 experiment ran on a Linux x64 VM with an AMD EPYC 9V74, a fresh X display, software graphics and a temporary profile. The source was a generated Electron page with either a spreadsheet, moving cursor and row highlight or an animated colored tile field. The harness grants only that frame and requests no audio. It observed permission denial before granting capture. Each eight-second sample used WebCodecs VP8, requested 1280 × 720 at 15 fps with a 1.5 Mbit/s target, decoded every encoded frame, and observed the capture track end on Stop.

| Generated scene | Decoded / encoded | Actual fps | Video payload, Mbit/s | Submit-to-encoded p95 | Process CPU, % of one core |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spreadsheet | 119 / 119 | 14.8 | 0.768 | 7.7 ms | 42.3% |
| Moving tiles | 120 / 120 | 14.9 | 1.504 | 8.0 ms | 47.9% |

The CPU sample includes source rendering, capture, encoding and local decoding across Electron processes present at both ends of the sample. It excludes the X server. A second run that retained the encoded motion frames for the routing experiment produced 120 / 120 frames at 1.500 Mbit/s. The encoder queue dropped zero frames in both runs. Neither stimulus represents full-motion gameplay.

## Two real routes on 127.0.0.1

The routing experiment paced the same 1,505,264 bytes and 120 encoded frames over a separate libp2p stream. One restricted sender connected directly to a full node, then sent to another restricted endpoint over that node's circuit. The receiver verified every frame's bytes. The sender also generated 120-byte voice payloads on a nominal 20 ms timer through the app's existing voice transport.

| Observed route | Video frames received | Send-to-read p95 | Voice payloads received / sent | Voice arrival gap p95 / maximum |
| --- | ---: | ---: | ---: | ---: |
| Direct TCP | 120 / 120 | 1.8 ms | 392 / 392 | 22.1 / 44 ms |
| Circuit through the full node | 120 / 120 | 4.3 ms | 385 / 385 | 21.9 / 101 ms |

The send-to-read sample starts when each encoded frame enters the stream and ends after the receiver assembles its complete bytes. These measurements exclude capture, playback and screen latency. The 101 ms maximum arrival gap warrants investigation under load. Synthetic voice payloads cannot establish intelligibility. The experiment did not induce packet loss or interrupt the relay.

## Transport and release gate

At the measured motion rate, one viewer behind the circuit costs the relay about 1.50 Mbit/s inbound and 1.50 Mbit/s outbound in video payload alone. Two independent such circuits require about 3 Mbit/s in each direction before protocol overhead, voice and chat. An average encoded motion frame in this run was about 12.5 kB. The voice protocol limits its whole frame body to 4,000 bytes.

Start with one viewer on a dedicated stream and use the authenticated direct connection when present. A verified circuit is a candidate fallback with measured upstream headroom. Keep video out of the history, file and Opus protocols. The prototype's reader knows the original frame lengths. A product protocol needs its own bounded framing, codec negotiation, keyframe recovery, congestion control, authorization of each viewer, and a prompt downgrade or stop of video when voice queues grow. Room election alone establishes no bandwidth budget.

The field decision still needs a consenting Windows sharer and viewer, source preview and selection, a visible sharing indicator, Stop/Idle/Quit release, cold restart with capture off, and real direct/relayed tests with gameplay and intelligible speech. Measure latency from a visible source change to viewer display, real uplink and CPU, then disconnect the relay and verify the supported fallback. Keep only consenting participants and screens in that test.

Run the opt-in benchmark from the checkout with dependencies installed. It launches independently of the chat app. Omit the final flag to measure capture and local decoding only.

```sh
npx --no-install electron tools/screenshare-bench/main.cjs --loopback-routes
```
