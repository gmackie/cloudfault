# Terminal recording behind docs/media/report.webm and report.png. Do not run
# this directly; use `npm run media:report` (scripts/record-report.mjs), which
# adds an absolute frame-directory Output and encodes the frames with ffmpeg.
#
# It runs the real workerd checkout fixture (examples/checkout), so the report
# is CloudFault's actual output, not a mock-up.

Require node

Set Shell "bash"
Set FontSize 14
Set Width 1600
Set Height 900
Set Padding 28
Set Theme "GitHub Dark"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type `export PS1='$ ' PATH="$PWD/node_modules/.bin:$PATH" FORCE_COLOR=1 && rm -rf .cloudfault/failures .cloudfault/reports && clear`
Enter
Show

Sleep 800ms
Type "# checkout Worker in real workerd: stale KV read x payment commit-then-timeout"
Sleep 600ms
Enter
Type "cloudfault run ./examples/checkout/scenario.mjs"
Sleep 500ms
Enter
Wait+Screen@60s /Replay:/
Sleep 5s
Enter

Type "# the failure artifact replays deterministically"
Sleep 500ms
Enter
Type "cloudfault replay .cloudfault/failures/*.json"
Sleep 500ms
Enter
Wait+Screen@60s /REPRODUCED/
Sleep 6s
