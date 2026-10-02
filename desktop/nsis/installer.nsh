; 升级安装前的清理：杀掉一切 10Router 进程。
;
; 背景：sidecar（Next 服务）与托盘是同一个 10Router.exe（以
; ELECTRON_RUN_AS_NODE 启动的无窗口进程），没有窗口可关；而「升级」路径跑的是
; 【旧版本】的卸载器——它的代码无法修改，旧版卸载器杀不掉这个无窗 sidecar，
; 于是文件锁不释放，报「Failed to uninstall old application files」（v1.3.0
; 升级 1.3.1 实测复现）。customInit 在新安装器的安装段最早执行、先于旧卸载器
; 运行，统一在这里强杀（安装器自己的会话列表此时没有任何 10Router 进程，杀错
; 不可能）。
!macro customInit
  DetailPrint "Stopping any running 10Router processes..."
  nsExec::ExecToStack 'taskkill /F /IM 10Router.exe /T'
  Pop $0   ; taskkill 退出码（进程不存在也会报 error，属预期）
  Pop $1   ; 输出（丢弃）
  Sleep 1500
!macroend
