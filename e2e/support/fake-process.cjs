'use strict';

/*
 * A stand-in game server for the browser tests.
 *
 * Hostkind's `custom` module runs an arbitrary process and treats its stdout
 * as the console, so this script gives the tests a *real* managed process -
 * real spawn, real stdout streaming over the WebSocket, real stop sequence,
 * real exit codes - without installing Java or a game.
 *
 * Protocol (kept deliberately small; the specs assert on these exact lines):
 *
 *   on start        prints "[fake] booting", then "[fake] ready" once it is up
 *   <anything>      echoed back as "[fake] echo: <anything>"
 *   stop            prints "[fake] stopping" and exits 0
 *   boom            exits 1 without a word, to look like a crash
 *   say <text>      prints "<text>" verbatim, for console-rendering assertions
 *   spam <n>        prints n numbered lines as fast as it can
 *
 * FAKE_BOOT_MS delays the ready line, for tests that need to see "starting".
 */

const bootDelay = Number(process.env.FAKE_BOOT_MS || 0);

function say(line) {
  process.stdout.write(`${line}\n`);
}

say('[fake] booting');
setTimeout(() => say('[fake] ready'), bootDelay);

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline = buffered.indexOf('\n');
  while (newline !== -1) {
    handle(buffered.slice(0, newline).replace(/\r$/, '').trim());
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf('\n');
  }
});

function handle(command) {
  if (!command) return;
  if (command === 'stop') {
    say('[fake] stopping');
    process.exit(0);
  }
  if (command === 'boom') {
    process.exit(1);
  }
  if (command.startsWith('say ')) {
    say(command.slice(4));
    return;
  }
  if (command.startsWith('spam ')) {
    const count = Math.min(Number(command.slice(5)) || 0, 2000);
    for (let i = 1; i <= count; i += 1) say(`[fake] line ${i}`);
    return;
  }
  say(`[fake] echo: ${command}`);
}

// A stop that arrives as a signal rather than a command still shuts down
// cleanly, which is what the panel falls back to when stopCommand is unset.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    say('[fake] stopping');
    process.exit(0);
  });
}

// Keep the event loop alive even if stdin closes.
setInterval(() => {}, 1 << 30);
