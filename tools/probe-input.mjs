/**
 * Check whether this process can actually drive the mouse and keyboard.
 *
 * Recording a demo is pointless if input cannot be injected, so this is the go/no-go probe: it
 * reports the screen size, reads the cursor position, moves the cursor by a small delta, and reads it
 * back. A move that does not take effect means the process is in a different session or lacks input
 * rights, and the whole "record it automatically" approach is off.
 *
 * The PowerShell snippets are built by string concatenation rather than template literals, because
 * PowerShell's `$var` syntax collides with JavaScript interpolation.
 *
 * Usage: node tools/probe-input.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/probe-input
 */
import { execFileSync } from 'node:child_process';

const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();

const WIN32 = [
  "Add-Type @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class W {',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }',
  '}',
  "'@",
].join('\n');

const readCursor = (base) => {
  const out = ps([base, '$p = New-Object W+P', '[void][W]::GetCursorPos([ref]$p)', 'Write-Output "$($p.X),$($p.Y)"'].join('\n'));
  const parts = out.split(',').map(Number);
  return { x: parts[0], y: parts[1] };
};

console.log('=== system metrics ===');
console.log(
  ' ',
  ps(
    [
      WIN32,
      '$w = [W]::GetSystemMetrics(0)',
      '$h = [W]::GetSystemMetrics(1)',
      '$vw = [W]::GetSystemMetrics(76)',
      '$vh = [W]::GetSystemMetrics(77)',
      'Write-Output "primary=$($w)x$($h)  virtual=$($vw)x$($vh)"',
    ].join('\n'),
  ),
);

console.log('=== reading the cursor ===');
const before = readCursor(WIN32);
console.log('  cursor at', before.x + ',' + before.y);

console.log('=== moving the cursor by (+37, +23) and reading it back ===');
const target = { x: before.x + 37, y: before.y + 23 };
ps(
  [
    WIN32,
    '$ok = [W]::SetCursorPos(' + target.x + ', ' + target.y + ')',
    'Start-Sleep -Milliseconds 200',
    'Write-Output $ok',
  ].join('\n'),
);
const after = readCursor(WIN32);
console.log('  asked for', target.x + ',' + target.y, '— cursor reports', after.x + ',' + after.y);

const worked = Math.abs(after.x - target.x) <= 2 && Math.abs(after.y - target.y) <= 2;
if (worked) {
  console.log('\nRESULT: input injection WORKS ✅');
  console.log('  (cursor moved, and the move was observable from this process)');
  ps([WIN32, '[void][W]::SetCursorPos(' + before.x + ', ' + before.y + ')'].join('\n'));
  console.log('  cursor restored to', before.x + ',' + before.y);
  process.exit(0);
}
console.log('\nRESULT: input injection FAILED ❌');
console.log('  The process is likely in a different session, or lacks input rights.');
process.exit(1);
