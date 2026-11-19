import { HELPER_HASH, HELPER_SOURCE } from "./powershell-helper.cs";

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
    InPrompt   = $false
    HasHelper  = $false
    OrigPrompt = $function:prompt
    BinPath    = $null
    TabFallback      = $null
    ShiftTabFallback = $null
    DaemonStartAt    = [datetime]::MinValue
}
$__swPrevOrig = $null
if ($__swPrev) {
    # Loaded again in the same shell: same session, and what was already
    # recorded stays recorded. Tab is bound to our handler by now; what it
    # fell back to is only known from the earlier load.
    $global:__sw.Session = $__swPrev.Session
    $global:__sw.LastId = $__swPrev.LastId
    $global:__sw.TabFallback = $__swPrev.TabFallback
    $global:__sw.ShiftTabFallback = $__swPrev.ShiftTabFallback
    $__swPrevOrig = $__swPrev.OrigPrompt
} else {
    $__swLast = Get-History -Count 1
    if ($__swLast) { $global:__sw.LastId = $__swLast.Id }
}
$__swCmd = Get-Command -Name $global:__sw.Bin -CommandType Application -ErrorAction Ignore | Select-Object -First 1
if ($__swCmd) { $global:__sw.BinPath = $__swCmd.Path }

# --- Command capture ---

function global:__sw_spawn([string[]]$SwArgs, [hashtable]$EnvVars) {
    # Fire-and-forget with no window. Values travel in the child's env vars,
    # never on the command line, whose quoting would mangle them.
    if (-not $global:__sw.BinPath) { return }
    $newPsi = {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        if ($global:__sw.BinPath -match '\.(cmd|bat)$') {
            $psi.FileName = $env:ComSpec
            $psi.Arguments = '/d /c ""' + $global:__sw.BinPath + '" ' + ($SwArgs -join ' ') + '"'
        } else {
            $psi.FileName = $global:__sw.BinPath
            $psi.Arguments = $SwArgs -join ' '
        }
        # CreateProcess (not ShellExecute, which would run the Windows zone
        # check on a downloaded binary each time). The child also inherits
        # this shell's inheritable handles, a caller's output pipe among them:
        # harmless in a short-lived child, and daemon start clears them before
        # it starts the long-lived daemon.
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi
    }
    # The child gets its own copy of the environment with the values added;
    # this shell's is not touched.
    $viaShellEnv = $false
    try {
        $psi = & $newPsi
        foreach ($k in $EnvVars.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvVars[$k] }
    } catch {
        # Windows PowerShell's .NET cannot copy an environment that has two
        # names differing only in case (Path and PATH), and the failed copy
        # stays half-filled in $psi. Start from a fresh one, which inherits
        # this shell's environment, and put the values there for the moment
        # of the start only.
        $psi = & $newPsi
        $viaShellEnv = $true
        foreach ($k in $EnvVars.Keys) { [Environment]::SetEnvironmentVariable($k, [string]$EnvVars[$k]) }
    }
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        if ($p) { $p.Dispose() }
    } catch {
    } finally {
        if ($viaShellEnv) {
            foreach ($k in $EnvVars.Keys) { [Environment]::SetEnvironmentVariable($k, $null) }
        }
    }
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
    $cwd = (Get-Location).ProviderPath
    if ($global:__sw.HasHelper) {
        # Straight over the daemon's socket: no process to start.
        if ([ShellwiseClient]::Add($global:__sw.Socket, $cmd, $cwd, $exit, $dur, $global:__sw.Session, 'powershell')) { return }
    }
    # A hidden shellwise add, which stores the command itself when no daemon
    # answers.
    __sw_spawn @('add', '--from-env') @{
        SW_ADD_COMMAND = $cmd; SW_ADD_CWD = $cwd; SW_ADD_EXIT_CODE = $exit
        SW_ADD_DURATION = $dur; SW_ADD_SESSION = $global:__sw.Session; SW_ADD_SHELL = 'powershell'
    }
    if ($global:__sw.HasHelper) { __sw_start_daemon }
}

# The daemon went away (idle timeout, stopped) or is not up yet: the
# suggestions need it. Not again within 10 s: until a new daemon answers,
# every command comes here, and two starts at once leave a second daemon
# running unreachable until its idle timeout.
function global:__sw_start_daemon {
    if (([datetime]::UtcNow - $global:__sw.DaemonStartAt).TotalSeconds -lt 10) { return }
    $global:__sw.DaemonStartAt = [datetime]::UtcNow
    __sw_spawn @('daemon', 'start') @{}
}

# Returns a prompt that records the last command, then calls $Orig. Each
# wrapper keeps the prompt it captured itself, never a shared slot: when a
# tool (a venv's Activate.ps1, zoxide) has wrapped ours and this script is
# loaded again, the new wrapper calls that tool's prompt, which calls the old
# wrapper, which still calls the original. No load can make a cycle.
function global:__sw_wrap([scriptblock]$Orig) {
    $swOrig = $Orig
    {
        $__swOk = $?
        if ($global:__sw.InPrompt) {
            # Inside our own outer wrapper: it has recorded already, so only
            # hand the status on.
            if ($__swOk) { $null = 1 } else { Write-Error '' -ErrorAction Ignore }
            & $swOrig
            return
        }
        # Unset until a native command has run: see Get-Variable above.
        $__swCode = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore
        try {
            $global:__sw.LastOk = $__swOk
            __sw_record $__swOk $__swCode
        } catch {}
        # Hand the real status on to the wrapped prompt (oh-my-posh, starship, ...).
        if ($null -ne $__swCode) { $global:LASTEXITCODE = $__swCode }
        $global:__sw.InPrompt = $true
        try {
            if ($__swOk) { $null = 1 } else { Write-Error '' -ErrorAction Ignore }
            & $swOrig
        } finally {
            $global:__sw.InPrompt = $false
        }
    }.GetNewClosure()
}

if ("$function:prompt" -match '__sw_record') {
    # Our wrapper is still on top (the script loaded twice in a row): keep it.
    $global:__sw.OrigPrompt = $__swPrevOrig
} else {
    if (-not $global:__sw.OrigPrompt) {
        $global:__sw.OrigPrompt = { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
    }
    Set-Item -Path function:global:prompt -Value (__sw_wrap $global:__sw.OrigPrompt)
}
Remove-Variable -Name __swPrev, __swPrevOrig, __swCmd, __swLast -ErrorAction Ignore

# The socket file survives logoff and killed daemons on Windows, so its
# presence proves nothing. Always ask (hidden, non-blocking): daemon start
# returns at once when a live daemon answers.
__sw_start_daemon

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
            # The TUI drew over the prompt line and left the cursor at the start
            # of that line. Redraw the prompt there, not where PSReadLine last
            # put it: to make room for its frame the TUI may have scrolled the
            # buffer, which a pseudo console (Windows Terminal, VS Code) always
            # does since it has no scrollback, and the old row is then stale.
            $top = [Console]::CursorTop - (Get-PSReadLineOption).ExtraPromptLineCount
            if ($top -lt 0) { $top = 0 }
            # With the last command's $?: InvokePrompt would otherwise show this
            # handler's own.
            if ($global:__sw.LastOk) { $null = 1 } else { Write-Error '' -ErrorAction Ignore }
            [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt($null, $top)
            if ($selected) {
                # Replace what was typed. RevertLine + Insert appended the choice
                # to it while a prediction list was showing (RevertLine then
                # only closes the list).
                [Microsoft.PowerShell.PSConsoleReadLine]::Replace(0, $line.Length, ($selected -join [char]10))
            }
        } finally {
            Remove-Item -Path Env:SW_QUERY -ErrorAction Ignore
            [Console]::OutputEncoding = $prevEnc
        }
    }
}

# --- Suggestions while typing: pwsh 7.2+ with PSReadLine 2.2.2+ ---

# A predictor asks the daemon as you type; PSReadLine shows the answers in
# its list and Tab / Shift+Tab walk it. Any failure here leaves the shell as
# set up above: capture and Ctrl+R work, Tab keeps its binding. Windows
# PowerShell parses this part but never runs it, nor compiles the C#.
try {
    $__swRl = Get-Module -Name PSReadLine | Select-Object -First 1
    if ($PSVersionTable.PSVersion -ge [version]'7.2' -and $__swRl -and $__swRl.Version -ge [version]'2.2.2') {
        if (-not ('ShellwisePredictor' -as [type])) {
            # Compiled once per helper source and pwsh version (~0.5 s), then
            # loaded from the cache.
            $__swV = $PSVersionTable.PSVersion
            $__swDll = Join-Path $global:__sw.DataDir "ps\shellwise-helper-${HELPER_HASH}-$($__swV.Major).$($__swV.Minor).dll"
            if (-not [System.IO.File]::Exists($__swDll)) {
                $__swDir = [System.IO.Path]::GetDirectoryName($__swDll)
                $null = [System.IO.Directory]::CreateDirectory($__swDir)
                $__swTmp = "$__swDll.$PID.tmp"
                Add-Type -OutputAssembly $__swTmp -ErrorAction Stop -TypeDefinition @'
${HELPER_SOURCE}'@
                try {
                    # Fails when another shell starting at the same time got
                    # there first: then its DLL is as good as ours.
                    [System.IO.File]::Move($__swTmp, $__swDll)
                } catch {
                    try { [System.IO.File]::Delete($__swTmp) } catch {}
                }
                # Builds of other sources. A shell still running one keeps it
                # locked; the next start retries.
                foreach ($__swOld in [System.IO.Directory]::GetFiles($__swDir, 'shellwise-helper-*.dll')) {
                    if ([System.IO.Path]::GetFileName($__swOld) -notlike 'shellwise-helper-${HELPER_HASH}-*') {
                        try { [System.IO.File]::Delete($__swOld) } catch {}
                    }
                }
            }
            Add-Type -LiteralPath $__swDll -ErrorAction Stop
        }
        [ShellwisePredictor]::SocketPath = $global:__sw.Socket
        $global:__sw.HasHelper = $true
        # Registered already when the script was loaded before in this shell.
        $__swPredictor = [ShellwisePredictor]::new()
        $__swKind = [System.Management.Automation.Subsystem.SubsystemKind]::CommandPredictor
        $__swInfo = [System.Management.Automation.Subsystem.SubsystemManager]::GetSubsystemInfo($__swKind)
        if (-not ($__swInfo.Implementations | Where-Object { $_.Id -eq $__swPredictor.Id })) {
            [System.Management.Automation.Subsystem.SubsystemManager]::RegisterSubsystem($__swKind, $__swPredictor)
        }

        $__swOpt = Get-PSReadLineOption
        if ("$($__swOpt.PredictionSource)" -eq 'None') {
            Set-PSReadLineOption -PredictionSource Plugin -ErrorAction Stop
        } elseif ("$($__swOpt.PredictionSource)" -eq 'History') {
            Set-PSReadLineOption -PredictionSource HistoryAndPlugin -ErrorAction Stop
        }
        Set-PSReadLineOption -PredictionViewStyle ListView -ErrorAction Stop

        # What Tab and Shift+Tab did so far: they keep doing it whenever no
        # list is showing. Only a PSReadLine function can be called from our
        # handler; a script block bound by the user cannot be read back.
        $__swKeyFn = {
            param([string]$Chord, $Kept, [string]$Default)
            $h = Get-PSReadLineKeyHandler -Chord $Chord | Select-Object -First 1
            $fn = if ($h) { [string]$h.Function } else { '' }
            $sig = [type[]]@([System.Nullable[System.ConsoleKeyInfo]], [object])
            if ($fn -and [Microsoft.PowerShell.PSConsoleReadLine].GetMethod($fn, $sig)) { return $fn }
            # Our own handler, from an earlier load: keep what it called.
            if ($Kept) { return $Kept }
            $Default
        }
        $global:__sw.TabFallback = & $__swKeyFn 'Tab' $global:__sw.TabFallback 'TabCompleteNext'
        $global:__sw.ShiftTabFallback = & $__swKeyFn 'Shift+Tab' $global:__sw.ShiftTabFallback 'TabCompletePrevious'

        # Moving in the list puts the chosen line in the buffer. When the
        # buffer did not change, no list was showing: do the key's old job.
        Set-PSReadLineKeyHandler -Chord 'Tab' -BriefDescription 'ShellwiseNext' -Description 'Next shellwise suggestion, or the previous Tab function' -ScriptBlock {
            param($key, $arg)
            $before = $null; $after = $null; $cursor = $null
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$before, [ref]$cursor)
            [Microsoft.PowerShell.PSConsoleReadLine]::NextSuggestion($key, $arg)
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$after, [ref]$cursor)
            if ($after -ceq $before) {
                [Microsoft.PowerShell.PSConsoleReadLine]::($global:__sw.TabFallback).Invoke($key, $arg)
            }
        }
        Set-PSReadLineKeyHandler -Chord 'Shift+Tab' -BriefDescription 'ShellwisePrevious' -Description 'Previous shellwise suggestion, or the previous Shift+Tab function' -ScriptBlock {
            param($key, $arg)
            $before = $null; $after = $null; $cursor = $null
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$before, [ref]$cursor)
            [Microsoft.PowerShell.PSConsoleReadLine]::PreviousSuggestion($key, $arg)
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$after, [ref]$cursor)
            if ($after -ceq $before) {
                [Microsoft.PowerShell.PSConsoleReadLine]::($global:__sw.ShiftTabFallback).Invoke($key, $arg)
            }
        }
    }
} catch {}
Remove-Variable -Name __swRl, __swV, __swDll, __swDir, __swTmp, __swOld, __swPredictor, __swKind, __swInfo, __swOpt, __swKeyFn -ErrorAction Ignore
`;
}
