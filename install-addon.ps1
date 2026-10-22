param([ValidatePattern('^\d+\.\d+$')][string]$Version, [switch]$Enable)
$ErrorActionPreference = 'Stop'
if (!$Version) { throw 'Select the intended Blender explicitly with -Version <major.minor>.' }
$source = Join-Path $PSScriptRoot 'blender_bridge'
$base = Join-Path $env:APPDATA "Blender Foundation\Blender\$Version\scripts\addons"
$target = Join-Path $base 'blender_bridge'
New-Item -ItemType Directory -Path $target -Force | Out-Null
# Copy only maintained sources. No recursive delete and no user preferences reset.
Copy-Item -LiteralPath (Join-Path $source '__init__.py'),(Join-Path $source 'server.py'),(Join-Path $source 'screenshot.py') -Destination $target -Force
Write-Output "Installed -> $target"
if ($Enable) {
    $exe = Join-Path $env:ProgramFiles "Blender Foundation\Blender $Version\blender.exe"
    if (!(Test-Path -LiteralPath $exe)) { throw "Blender executable not found: $exe" }
    $script = @'
import bpy
import addon_utils
if 'dsh_blender_bridge' in bpy.context.preferences.addons:
    addon_utils.disable('dsh_blender_bridge', default_set=True)
addon_utils.enable('blender_bridge', default_set=True, persistent=True)
assert 'blender_bridge' in bpy.context.preferences.addons
bpy.ops.wm.save_userpref()
'@
    & $exe --background --python-exit-code 1 --python-expr $script
    if ($LASTEXITCODE -ne 0) { throw 'Addon enable failed' }
    Write-Output 'Enabled Blender Bridge for future launches. Restart open Blender to load the installed version.'
} else {
    Write-Output 'Enable Blender Bridge in Preferences > Add-ons. Disable DSH Blender Bridge in the same step to avoid two executors.'
}
