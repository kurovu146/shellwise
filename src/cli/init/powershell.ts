export interface PowerShellContext {
  socketPath: string;
  dataDir: string;
}

/**
 * `s` as a PowerShell string expression made of ASCII only. PowerShell decodes
 * a native command's stdout with the console code page, so a non-ASCII byte in
 * `shellwise init powershell | Invoke-Expression` would arrive mangled; such
 * characters are spelled out as `[char]0x....` instead.
 */
function psString(s: string): string {
  const quote = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const parts: string[] = [];
  let literal = "";
  // UTF-16 code units: a surrogate pair becomes two [char]s, which concatenate
  // back into the same character.
  for (const unit of s.split("")) {
    const code = unit.charCodeAt(0);
    if (code < 0x80) {
      literal += unit;
      continue;
    }
    // Leading with a string literal keeps every `+` a string concatenation.
    if (literal || parts.length === 0) parts.push(quote(literal));
    parts.push(`[char]0x${code.toString(16).padStart(4, "0")}`);
    literal = "";
  }
  if (parts.length === 0) return quote(literal);
  if (literal) parts.push(quote(literal));
  return `(${parts.join(" + ")})`;
}

// Must load in Windows PowerShell 5.1 as well as pwsh 7: no `?:`, `??`, `&&`,
// and no .NET API newer than .NET Framework 4.8.
export function generatePowerShellScript(bin: string, ctx: PowerShellContext): string {
  return String.raw`
# --- shellwise shell integration ---

# Get-Variable, not $global:__sw: under Set-StrictMode, reading an unset
# variable throws (here on first load, and $LASTEXITCODE in the prompt).
$__swPrev = Get-Variable -Name __sw -Scope Global -ValueOnly -ErrorAction Ignore
$global:__sw = @{
    Bin        = ${psString(bin)}
    Socket     = ${psString(ctx.socketPath)}
    DataDir    = ${psString(ctx.dataDir)}
    Session    = [guid]::NewGuid().ToString()
    LastId     = -1
    LastOk     = $true
    HasHelper  = $false
    OrigPrompt = $function:prompt
    BinPath    = $null
}
# Loaded again (a reloaded profile) while our wrapper is still the prompt:
# wrapping it once more would make the prompt call itself forever.
if ($__swPrev -and "$function:prompt" -match '__sw_record') {
    $global:__sw.OrigPrompt = $__swPrev.OrigPrompt
    $global:__sw.Session = $__swPrev.Session
}
if (-not $global:__sw.OrigPrompt) {
    $global:__sw.OrigPrompt = { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}
$__swCmd = Get-Command -Name $global:__sw.Bin -CommandType Application -ErrorAction Ignore | Select-Object -First 1
if ($__swCmd) { $global:__sw.BinPath = $__swCmd.Path }
$__swLast = Get-History -Count 1
if ($__swLast) { $global:__sw.LastId = $__swLast.Id }
Remove-Variable -Name __swPrev, __swCmd, __swLast -ErrorAction Ignore

# --- Command capture ---

function global:__sw_spawn([string[]]$SwArgs, [hashtable]$EnvVars) {
    # Fire-and-forget with no window. Values travel in env vars, never on the
    # command line, whose quoting would mangle them.
    if (-not $global:__sw.BinPath) { return }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($global:__sw.BinPath -match '\.(cmd|bat)$') {
        $psi.FileName = $env:ComSpec
        $psi.Arguments = '/d /c ""' + $global:__sw.BinPath + '" ' + ($SwArgs -join ' ') + '"'
    } else {
        $psi.FileName = $global:__sw.BinPath
        $psi.Arguments = $SwArgs -join ' '
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($k in $EnvVars.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvVars[$k] }
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        if ($p) { $p.Dispose() }
    } catch {}
}

function global:__sw_record([bool]$Ok, $Code) {
    $h = Get-History -Count 1
    if (-not $h -or $h.Id -eq $global:__sw.LastId) { return }
    $global:__sw.LastId = $h.Id
    $cmd = $h.CommandLine
    # The daemon's wire protocol is line-based.
    if (-not $cmd -or $cmd -match "[\r\n]") { return }
    $exit = if ($Ok) { 0 } elseif ($Code) { [int]$Code } else { 1 }
    $dur = [int]($h.EndExecutionTime - $h.StartExecutionTime).TotalMilliseconds
    __sw_spawn @('add', '--from-env') @{
        SW_ADD_COMMAND = $cmd; SW_ADD_CWD = (Get-Location).ProviderPath; SW_ADD_EXIT_CODE = $exit
        SW_ADD_DURATION = $dur; SW_ADD_SESSION = $global:__sw.Session; SW_ADD_SHELL = 'powershell'
    }
}

function global:prompt {
    $__swOk = $?
    # Unset until a native command has run: see Get-Variable above.
    $__swCode = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore
    try {
        $global:__sw.LastOk = $__swOk
        __sw_record $__swOk $__swCode
    } catch {}
    # Hand the real status on to the wrapped prompt (oh-my-posh, starship, ...).
    if ($null -ne $__swCode) { $global:LASTEXITCODE = $__swCode }
    if ($__swOk) { $null = 1 } else { Write-Error '' -ErrorAction Ignore }
    & $global:__sw.OrigPrompt
}

# The socket file survives logoff and killed daemons on Windows, so its
# presence proves nothing. Always ask (hidden, non-blocking): daemon start
# returns at once when a live daemon answers.
__sw_spawn @('daemon', 'start') @{}

# --- Ctrl+R: interactive search ---

if ($global:__sw.BinPath -and (Get-Command -Name Set-PSReadLineKeyHandler -ErrorAction Ignore)) {
    Set-PSReadLineKeyHandler -Chord 'Ctrl+r' -BriefDescription 'ShellwiseSearch' -Description 'shellwise fuzzy history search' -ScriptBlock {
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $prevEnc = [Console]::OutputEncoding
        $prevCode = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore
        try {
            # The TUI draws on the console itself; only the choice comes back on
            # stdout, as UTF-8. UTF-8 also has to stay on while PSReadLine draws
            # the new line: drawn right after a script handler under the console
            # code page, non-ASCII text shows as '?'.
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            # By env var: a Windows command line would mangle the quotes.
            $env:SW_QUERY = $line
            $selected = & $global:__sw.BinPath search
            # The search's exit must not change the status the prompt shows.
            if ($null -ne $prevCode) { $global:LASTEXITCODE = $prevCode } else { Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore }
            # The TUI drew over the prompt line. Redraw it with the last
            # command's $?: InvokePrompt would otherwise show this handler's.
            if ($global:__sw.LastOk) { $null = 1 } else { Write-Error '' -ErrorAction Ignore }
            [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()
            if ($selected) {
                [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
                [Microsoft.PowerShell.PSConsoleReadLine]::Insert(($selected -join [char]10))
            }
        } finally {
            Remove-Item -Path Env:SW_QUERY -ErrorAction Ignore
            [Console]::OutputEncoding = $prevEnc
        }
    }
}
`;
}
