; 升级安装前的清理：杀掉一切 10Router 进程。
;
; 背景：sidecar（Next 服务）与托盘是同一个 10Router.exe（以
; ELECTRON_RUN_AS_NODE 启动的无窗口进程），没有窗口可关；而「升级」路径跑的是
; 【旧版本】的卸载器——它的代码无法修改，旧版卸载器杀不掉这个无窗 sidecar，
; 于是文件锁不释放，报「Failed to uninstall old application files」（v1.3.0
; 升级 1.3.1 实测复现）。customInit 在新安装器的安装段最早执行、先于旧卸载器
; 运行，统一在这里强杀（安装器自己的会话列表此时没有任何 10Router 进程，杀错
; 不可能）。
;
; 为什么必须提权：安装器（oneClick:false 的 assisted installer）本身以普通
; 用户权限运行，taskkill 只能杀同权限或更低权限的进程。而 sidecar 由旧版 10Router
; 以「以管理员身份运行」拉起（MITM 绑定 443 需要），是高权限进程——安装器直接
; taskkill /IM 会被拒绝（access denied），旧卸载器在 CHECK_APP_RUNNING 里弹
; 「10Router 无法关闭」后放弃。这里改用 UAC 提权（-Verb RunAs）从高权限上下文
; 强杀：即便跳过 UAC 弹窗（拒绝提权），普通 taskkill 仍然会把「能杀的」托盘/
; sidecar 杀掉，最坏情况退化为和之前一致，不会更糟。编码是 PowerShell
; -EncodedCommand 的 UTF-16LE Base64 格式，直连系统 taskkill.exe 避免 PATH 投毒。
!macro customInit
  DetailPrint "Stopping any running 10Router processes..."
  nsExec::ExecToStack 'taskkill /F /IM 10Router.exe /T'
  Pop $0   ; taskkill 退出码（进程不存在也会报 error，属预期）
  Pop $1   ; 输出（丢弃）
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand aQBmACAAKABHAGUAdAAtAFAAcgBvAGMAZQBzAHMAIAAtAE4AYQBtAGUAIAAxADAAUgBvAHUAdABlAHIAIAAtAEUAcgByAG8AcgBBAGMAdABpAG8AbgAgAFMAaQBsAGUAbgB0AGwAeQBDAG8AbgB0AGkAbgB1AGUAKQAgAHsAIABTAHQAYQByAHQALQBQAHIAbwBjAGUAcwBzACAALQBGAGkAbABlAFAAYQB0AGgAIAB0AGEAcwBrAGsAaQBsAGwALgBlAHgAZQAgAC0AQQByAGcAdQBtAGUAbgB0AEwAaQBzAHQAIABAACgAJwAvAEYAJwAsACcALwBJAE0AJwAsACcAMQAwAFIAbwB1AHQAZQByAC4AZQB4AGUAJwAsACcALwBUACcAKQAgAC0AVgBlAHIAYgAgAFIAdQBuAEEAcwAgAC0AVwBhAGkAdAAgAC0AVwBpAG4AZABvAHcAUwB0AHkAbABlACAASABpAGQAZABlAG4AIAB9AA=='
  Pop $0   ; 提权脚本退出码（用户拒绝 UAC 属预期，忽略）
  Pop $1
  Sleep 1500
!macroend
