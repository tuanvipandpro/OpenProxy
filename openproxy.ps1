param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ProxyArgs)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $proxyNodePath = $nodeCommand.Source
} else {
    $proxyNodePath = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (-not (Test-Path -LiteralPath $proxyNodePath)) {
        Write-Error 'Node.js 22+ is required. Install Node.js or add it to PATH.'
        exit 1
    }
}
& $proxyNodePath (Join-Path $PSScriptRoot 'openproxy/cli.mjs') @ProxyArgs
exit $LASTEXITCODE
