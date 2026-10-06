#!/usr/bin/env node
/**
 * Code signing environment pre-check (Windows / electron-builder).
 *
 * Usage:
 *   node scripts/check-sign-env.mjs           # report only, always exit 0
 *   node scripts/check-sign-env.mjs --strict  # exit 1 when no usable certificate
 *
 * How electron-builder picks a certificate on Windows (verified against
 * app-builder-lib 24.9.1 source):
 *   1) win.certificateSubjectName / win.certificateSha1  -> Windows cert store
 *      (this is what EV USB tokens use)
 *   2) win.certificateFile + certificatePassword         -> PFX on disk
 *   3) env CSC_LINK (or WIN_CSC_LINK) + CSC_KEY_PASSWORD -> PFX path or base64
 *   NOTE: env CSC_NAME is macOS-only, it is IGNORED on Windows.
 *
 * stdout is ASCII-only on purpose: the Windows console may be GBK (cp936) and
 * UTF-8 Chinese would be printed as mojibake.
 */
import { existsSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const strict = process.argv.includes('--strict')
const root = path.resolve(import.meta.dirname, '..')

const lines = []
const problems = []
let usable = false

lines.push('=== GrClean code signing pre-check ===')

// ---------------------------------------------------------------- config file
const cfgPath = path.join(root, 'electron-builder.yml')
const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
/** read a win: level key, ignoring commented-out lines */
function cfgValue(key) {
  const m = cfgText.match(new RegExp(`^\\s{2}${key}:\\s*(.+?)\\s*$`, 'm'))
  if (!m) return ''
  return m[1].replace(/^['"]|['"]$/g, '').trim()
}
const subjectName = cfgValue('certificateSubjectName')
const certSha1 = cfgValue('certificateSha1')
const certFile = cfgValue('certificateFile')

// --------------------------------------------------------------- certificate
const cscLink = (process.env.CSC_LINK || process.env.WIN_CSC_LINK || '').trim()
const cscPassword = (
  process.env.CSC_KEY_PASSWORD ||
  process.env.WIN_CSC_KEY_PASSWORD ||
  ''
).trim()

if (subjectName || certSha1) {
  const hint = subjectName || certSha1
  lines.push(`[info] cert store mode -> looking up "${hint}" in Cert:\\CurrentUser\\My`)
  const found = findCertInStore(hint)
  if (found) {
    usable = true
    lines.push(`[ok]   cert found: ${found}`)
  } else {
    problems.push(`No private-key certificate matching "${hint}" in Cert:\\CurrentUser\\My`)
    lines.push(`[FAIL] no certificate matching "${hint}" in Cert:\\CurrentUser\\My`)
  }
} else if (certFile) {
  if (existsSync(certFile)) {
    usable = true
    lines.push(`[ok]   certificateFile: ${certFile} (${statSync(certFile).size} bytes)`)
  } else {
    problems.push(`certificateFile not found: ${certFile}`)
    lines.push(`[FAIL] certificateFile not found: ${certFile}`)
  }
} else if (cscLink) {
  const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(cscLink) && !cscLink.toLowerCase().endsWith('.pfx')
  if (!looksLikeBase64) {
    if (existsSync(cscLink)) {
      usable = true
      lines.push(`[ok]   CSC_LINK -> PFX file: ${cscLink} (${statSync(cscLink).size} bytes)`)
    } else {
      problems.push(`CSC_LINK points to a missing file: ${cscLink}`)
      lines.push(`[FAIL] CSC_LINK file not found: ${cscLink}`)
    }
  } else {
    const bytes = Buffer.from(cscLink.replace(/\s/g, ''), 'base64')
    if (bytes.length > 64 && bytes.subarray(0, 2).toString('hex') === '3082') {
      usable = true
      lines.push(`[ok]   CSC_LINK -> PFX base64 payload (${bytes.length} bytes decoded)`)
    } else {
      problems.push('CSC_LINK base64 payload does not look like a PKCS#12 (.pfx) blob')
      lines.push('[FAIL] CSC_LINK base64 payload is not a PFX blob')
    }
  }
  if (usable && !cscPassword) {
    lines.push('[warn] CSC_KEY_PASSWORD is empty (ok only for password-less PFX)')
  }
} else {
  lines.push('[skip] no certificate configured -> electron-builder will build WITHOUT signing')
  lines.push('')
  lines.push('How to enable signing (pick one):')
  lines.push('  A. PFX   -> $env:CSC_LINK="D:\\certs\\grclean.pfx"; $env:CSC_KEY_PASSWORD="<pwd>"')
  lines.push('  B. Store -> set "certificateSubjectName:" (or certificateSha1) under win: in electron-builder.yml')
  lines.push('Then run: npm run build:win:signed')
}

// ------------------------------------------------------------------ signtool
const signtool = findSigntool()
if (signtool) {
  lines.push(`[ok]   signtool: ${signtool}`)
} else {
  lines.push('[info] signtool not on PATH; electron-builder ships its own copy (winCodeSign cache), fine')
}

// ------------------------------------------------------------------ reminder
lines.push('')
lines.push('Reminder: sign first, then compute hashes.')
lines.push('  Signature changes exe bytes (GrClean.exe / setup.exe / portable.exe);')
lines.push('  resources/app.asar is not signed, its hash stays the same.')

process.stdout.write(lines.join('\n') + '\n')

if (strict && (!usable || problems.length)) {
  process.stderr.write('strict mode: signing environment is not usable, aborting.\n')
  process.exit(1)
}

function findCertInStore(hint) {
  try {
    const safe = hint.replace(/["'`$]/g, '')
    const ps = [
      '$c = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey -and ($_.Subject -like "*' +
        safe +
        '*" -or $_.Thumbprint -eq "' +
        safe +
        '") }',
      'if ($c) { $c | Select-Object -First 1 -ExpandProperty Subject }'
    ].join('; ')
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  } catch {
    return ''
  }
}

function findSigntool() {
  try {
    const where = execFileSync('where', ['signtool.exe'], { encoding: 'utf8', windowsHide: true })
    return where.split(/\r?\n/)[0].trim()
  } catch {
    const base = path.join(
      process.env.LOCALAPPDATA || '',
      'electron-builder',
      'Cache',
      'winCodeSign',
      'winCodeSign-2.6.0',
      'windows-10',
      'x64',
      'signtool.exe'
    )
    return existsSync(base) ? base : ''
  }
}
