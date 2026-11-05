# 恢复被压缩掉的历史（手动执行版）
#
# 这个脚本**不碰任何进程**——它只做三件纯文件操作：
#   1. 把当前会话备份到 fish-backup
#   2. 跑 restore_transform.py 生成改造版
#   3. 校验产物没问题，覆盖会话文件
#
# 前置条件：DSH web 必须是**停着**的。脚本开头会检查，还在跑就直接退出。
# 跑完之后，你自己启动 DSH web。

$ErrorActionPreference = 'Stop'

$SessDir   = 'C:\Users\Administrator\.dsh\sessions\--C-Users-Administrator-qq-bridge-state-agents--\session-06d894e1-5fdf-457c-85e6-ad669235f12d'
$SessFile  = Join-Path $SessDir 'session.v4.jsonl.zstd'
$BackupDir = 'C:\Users\Administrator\Documents\fish-backup\2026-11-05'
$AgentDir  = 'C:\Users\Administrator\qq-bridge\state\agents'
$Xform     = Join-Path $AgentDir 'restore_transform.py'
$Log       = Join-Path $AgentDir 'restore-log.txt'

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $Log -Value $line -Encoding utf8
    Write-Host $line
}

Write-Host ''
Write-Host '=== 会话恢复 ===' -ForegroundColor Cyan
Say '=== manual restore started ==='

# --- 0. 必须先停掉 DSH web ---
$web = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'bin\.js"?\s+web' }
if ($web) {
    $pids = ($web | ForEach-Object { $_.ProcessId }) -join ', '
    Write-Host ''
    Write-Host "!! DSH web 还在跑（pid $pids）。" -ForegroundColor Red
    Write-Host '!! 请先把它停掉，再重新运行本脚本。' -ForegroundColor Red
    Say "ABORT: web still running ($pids)"
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
}
Say 'web is stopped, proceeding'

# --- 1. 备份 ---
if (-not (Test-Path $SessFile)) {
    Write-Host "!! 找不到会话文件：$SessFile" -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak    = Join-Path $BackupDir "session-06d894e1-AT-SWITCH-$stamp.jsonl.zstd"
Copy-Item $SessFile $bak -Force
$mbBefore = [math]::Round((Get-Item $SessFile).Length / 1MB, 2)
Say "backup ok -> $bak  ($($mbBefore) MB)"

# --- 2. 变换 ---
$tmp = "$SessFile.new"
if (Test-Path $tmp) { Remove-Item $tmp -Force }
Say 'running transform...'
$out = & python $Xform $SessFile $tmp 2>&1 | Out-String
Say ("transform: " + $out.Trim())

# --- 3. 校验 + 覆盖 ---
if (-not (Test-Path $tmp)) {
    Write-Host ''
    Write-Host '!! 变换没有产出文件，原始会话未改动。' -ForegroundColor Red
    Say 'ABORT: transform produced no file'
    Read-Host '按回车退出'
    exit 1
}
$mbNew = [math]::Round((Get-Item $tmp).Length / 1MB, 2)
if ($mbNew -lt 1) {
    Write-Host ''
    Write-Host "!! 产物只有 $mbNew MB，明显不对，原始会话未改动。" -ForegroundColor Red
    Say "ABORT: transform output too small ($mbNew MB)"
    Read-Host '按回车退出'
    exit 1
}

Copy-Item $tmp $SessFile -Force
Remove-Item $tmp -Force
Say "REPLACED session file: $mbBefore MB -> $mbNew MB"

Write-Host ''
Write-Host '=== 完成 ===' -ForegroundColor Green
Write-Host "  备份：$bak"
Write-Host "  会话：$($mbBefore) MB -> $($mbNew) MB"
Write-Host '  现在可以启动 DSH web 了。'
Write-Host '  如果起不来或历史不对，把备份那份覆盖回去就行。'
Write-Host ''
Read-Host '按回车退出'
