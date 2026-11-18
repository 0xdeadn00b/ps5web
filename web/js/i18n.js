// SPDX-License-Identifier: AGPL-3.0-only

const locales = ['en', 'zh-Hant', 'zh-Hans'];
const storageKey = 'ps5web.locale';
let locale = 'en';
try {
	const saved = localStorage.getItem(storageKey);
	if (locales.includes(saved)) locale = saved;
} catch { /* Storage is optional. */ }

// Each row contains English, Traditional Chinese, and Simplified Chinese.
// Upstream Chinese strings serve as keys so the call-site diffs stay small.
const messages = {
	"空闲": ["Idle", "閒置", "空闲"],
	"扫描中": ["Scanning", "掃描中", "扫描中"],
	"配对中": ["Pairing", "配對中", "配对中"],
	"连接中": ["Connecting", "連線中", "连接中"],
	"串流中": ["Streaming", "串流中", "串流中"],
	"知道了": ["Got it", "知道了", "知道了"],
	"未设置": ["Not set", "未設定", "未设置"],
	"观众": ["Viewer", "觀眾", "观众"],
	"我": ["Me", "我", "我"],
	"直播中": ["Live", "直播中", "直播中"],
	"还没连上直播，发不出去": ["Connect to the stream before sending a message.", "連上直播後才能傳送訊息。", "还没连上直播，发不出去"],
	"连接断了，弹幕发不出去": ["Disconnected. Your message was not sent.", "連線中斷，訊息未送出。", "连接断了，弹幕发不出去"],
	"连不上服务器，稍后自动重试…": ["Cannot reach the server. Retrying shortly…", "無法連接伺服器，稍後自動重試…", "连不上服务器，稍后自动重试…"],
	"直播已结束": ["Stream ended", "直播已結束", "直播已结束"],
	"现在没人在玩了。": ["Nobody is playing now.", "目前沒有人在玩。", "现在没人在玩了。"],
	"开始观战": ["Watch", "開始觀看", "开始观战"],
	"解锁并开播": ["Unlock and start stream", "解鎖並開始直播", "解锁并开播"],
	"现在没人在玩。开播会唤醒 PS5，需要访问密码（主机启动大约 30 秒）。": ["Nobody is playing. Starting the stream requires the access password and wakes the PS5 (about 30 seconds).", "目前沒有人在玩。開播需要存取密碼，並會喚醒 PS5（約 30 秒）。", "现在没人在玩。开播会唤醒 PS5，需要访问密码（主机启动大约 30 秒）。"],
	"房主还没有配对 PS5，暂时没有内容可看。": ["The host has not paired a PS5 yet. There is nothing to watch.", "房主尚未配對 PS5，目前沒有直播可看。", "房主还没有配对 PS5，暂时没有内容可看。"],
	"正在唤醒主机…": ["Waking the console…", "正在喚醒主機…", "正在唤醒主机…"],
	"登录已过期，请重新输入密码": ["Your login expired. Enter the password again.", "登入已逾時，請重新輸入密碼。", "登录已过期，请重新输入密码"],
	"连接中…": ["Connecting…", "連線中…", "连接中…"],
	"浏览器不支持 WebCodecs 音频解码，本次没有声音": ["This browser cannot decode WebCodecs audio. Audio is unavailable.", "此瀏覽器不支援 WebCodecs 音訊解碼，無法播放聲音。", "浏览器不支持 WebCodecs 音频解码，本次没有声音"],
	"开始串流": ["Start streaming", "開始串流", "开始串流"],
	"配对": ["Pair", "配對", "配对"],
	"唤醒": ["Wake", "喚醒", "唤醒"],
	"已发送唤醒包（若无效，请检查 PS5 的远程游玩设置）": ["Wake packet sent. If the console does not wake, check its Remote Play settings.", "已送出喚醒封包。若未喚醒，請檢查 PS5 的遙控遊玩設定。", "已发送唤醒包（若无效，请检查 PS5 的远程游玩设置）"],
	"删除": ["Delete", "刪除", "删除"],
	"删除这台主机？": ["Delete this console?", "刪除這台主機？", "删除这台主机？"],
	"取消": ["Cancel", "取消", "取消"],
	"已配对": ["Paired", "已配對", "已配对"],
	"未配对": ["Not paired", "未配對", "未配对"],
	"待机": ["Rest mode", "待命模式", "待机"],
	"在线": ["Online", "在線", "在线"],
	"添加并配对": ["Add and pair", "新增並配對", "添加并配对"],
	"扫描中…": ["Scanning…", "掃描中…", "扫描中…"],
	"扫描局域网": ["Scan local network", "掃描區域網路", "扫描局域网"],
	"没有发现主机。确认 NAS 与 PS5 同网段，并且容器用的是 host 网络。": ["No consoles found. Check that the NAS and PS5 are on the same subnet and that the container uses host networking.", "找不到主機。請確認 NAS 與 PS5 位於同一子網路，且容器使用 host 網路模式。", "没有发现主机。确认 NAS 与 PS5 同网段，并且容器用的是 host 网络。"],
	"PS5 上显示的 8 位数字": ["8-digit code shown on your PS5", "PS5 上顯示的 8 位數字", "PS5 上显示的 8 位数字"],
	"PSN Account-ID（base64，8 字节）": ["PSN Account ID (8 bytes, Base64)", "PSN 帳戶 ID（Base64，8 位元組）", "PSN Account-ID（base64，8 字节）"],
	"配对只需要做一次，凭据保存在 NAS 本地。": ["You only need to pair once. Credentials are stored locally on the NAS.", "只需配對一次，憑證會儲存在 NAS 本機。", "配对只需要做一次，凭据保存在 NAS 本地。"],
	"PIN 应该是 8 位数字": ["Enter the 8-digit PIN.", "請輸入 8 位數 PIN。", "PIN 应该是 8 位数字"],
	"请填写 PSN Account-ID": ["Enter your PSN Account ID.", "請輸入 PSN 帳戶 ID。", "请填写 PSN Account-ID"],
	"配对成功，可以直接串流了": ["Paired. You can now start streaming.", "已配對，現在可以開始串流。", "配对成功，可以直接串流了"],
	"开始配对": ["Start pairing", "開始配對", "开始配对"],
	"分辨率": ["Resolution", "解析度", "分辨率"],
	"帧率": ["Frame rate", "影格率", "帧率"],
	"码率": ["Bitrate", "位元率", "码率"],
	"开始": ["Start", "開始", "开始"],
	"小": ["Small", "小", "小"],
	"标准": ["Standard", "標準", "标准"],
	"大": ["Large", "大", "大"],
	"贴边": ["At edge", "貼邊", "贴边"],
	"适中": ["Medium", "適中", "适中"],
	"靠里": ["Inset", "向內", "靠里"],
	"很靠里": ["Extra inset", "更向內", "很靠里"],
	"显示": ["Show", "顯示", "显示"],
	"隐藏": ["Hide", "隱藏", "隐藏"],
	"自动": ["Auto", "自動", "自动"],
	"关闭": ["Close", "關閉", "关闭"],
	"按键大小": ["Button size", "按鍵大小", "按键大小"],
	"离边距离": ["Edge spacing", "邊緣間距", "离边距离"],
	"十字键": ["D-pad", "方向鍵", "十字键"],
	"震动反馈": ["Vibration feedback", "震動回饋", "震动反馈"],
	"恢复默认": ["Restore defaults", "還原預設值", "恢复默认"],
	"已恢复默认布局": ["Default layout restored.", "已還原預設配置。", "已恢复默认布局"],
	"按键布局": ["Button layout", "按鍵配置", "按键布局"],
	"完成": ["Done", "完成", "完成"],
	"NAS 上已有会话": ["A session is already running on the NAS", "NAS 上已有工作階段", "NAS 上已有会话"],
	"NAS 上已有串流": ["The NAS is already streaming", "NAS 已在串流", "NAS 上已有串流"],
	"结束旧的重开": ["Stop and restart", "結束後重新開始", "结束旧的重开"],
	"接入": ["Join", "加入", "接入"],
	"无法开始串流": ["Cannot start streaming", "無法開始串流", "无法开始串流"],
	"正在接回串流…": ["Rejoining stream…", "正在重新加入串流…", "正在接回串流…"],
	"接回来了，但没有画面": ["Reconnected, but no video", "已重新連線，但沒有畫面", "接回来了，但没有画面"],
	"结束这个会话": ["End this session", "結束這個工作階段", "结束这个会话"],
	"视频解码出错": ["Video decoding error", "視訊解碼錯誤", "视频解码出错"],
	"连接断开，重连中…": ["Disconnected. Reconnecting…", "連線中斷，正在重新連線…", "连接断开，重连中…"],
	"与 NAS 的连接断开": ["Disconnected from the NAS", "與 NAS 的連線中斷", "与 NAS 的连接断开"],
	"正在自动重连…": ["Reconnecting automatically…", "正在自動重新連線…", "正在自动重连…"],
	"视频解码不可用": ["Video decoding is unavailable", "無法解碼視訊", "视频解码不可用"],
	"这个会话已经结束了": ["This session has ended", "這個工作階段已結束", "这个会话已经结束了"],
	"正在连接 PS5…": ["Connecting to PS5…", "正在連線至 PS5…", "正在连接 PS5…"],
	"握手需要几秒，请稍候。": ["Connecting takes a few seconds. Please wait.", "建立連線需要幾秒，請稍候。", "握手需要几秒，请稍候。"],
	"正在唤醒 PS5…": ["Waking PS5…", "正在喚醒 PS5…", "正在唤醒 PS5…"],
	"慢一点，2 秒能发一条": ["You can send one message every two seconds.", "每兩秒可傳送一則訊息。", "慢一点，2 秒能发一条"],
	"说得够多啦，歇一小时再说": ["Chat limit reached. Try again in an hour.", "已達聊天上限，請一小時後再試。", "说得够多啦，歇一小时再说"],
	"会话中断": ["Session interrupted", "工作階段中斷", "会话中断"],
	"会话已结束": ["Session ended", "工作階段已結束", "会话已结束"],
	"正在结束会话…": ["Ending session…", "正在結束工作階段…", "正在结束会话…"],
	"主机正在进入待机…": ["Console is entering rest mode…", "主機正在進入待命模式…", "主机正在进入待机…"],
	"后台服务已退出": ["Background service stopped", "背景服務已停止", "后台服务已退出"],
	"NAS 上的桥接进程挂了，检查容器日志。": ["The bridge process stopped on the NAS. Check the container logs.", "NAS 上的橋接程序已停止，請檢查容器記錄。", "NAS 上的桥接进程挂了，检查容器日志。"],
	"8 位数字": ["8-digit code", "8 位數字", "8 位数字"],
	"PS5 要求输入配对 PIN": ["PS5 requires a pairing PIN", "PS5 要求輸入配對 PIN", "PS5 要求输入配对 PIN"],
	"PS5 屏幕上显示了 PIN，请输入。": ["Enter the PIN shown on the PS5 screen.", "請輸入 PS5 畫面上顯示的 PIN。", "PS5 屏幕上显示了 PIN，请输入。"],
	"取消串流": ["Cancel stream", "取消串流", "取消串流"],
	"提交": ["Submit", "送出", "提交"],
	"请输入数字 PIN": ["Enter a numeric PIN.", "請輸入數字 PIN。", "请输入数字 PIN"],
	"已提交 PIN": ["PIN submitted", "已送出 PIN", "已提交 PIN"],
	"已请求硬解": ["Hardware decoding requested", "已要求硬體解碼", "已请求硬解"],
	"默认": ["Default", "預設", "默认"],
	"返回": ["Back", "返回", "返回"],
	"分享": ["Share", "分享", "分享"],
	"选项": ["Options", "選項", "选项"],
	"运行日志": ["Runtime logs", "執行記錄", "运行日志"],
	"方向键": ["Arrow keys", "方向鍵", "方向键"],
	"左摇杆": ["Left stick", "左搖桿", "左摇杆"],
	"触摸板按下": ["Press touchpad", "按下觸控板", "触摸板按下"],
	"PS 键": ["PS button", "PS 鍵", "PS 键"],
	"鼠标拖动": ["Drag mouse", "拖曳滑鼠", "鼠标拖动"],
	"触摸板滑动": ["Swipe touchpad", "滑動觸控板", "触摸板滑动"],
	"键盘 / 鼠标映射": ["Keyboard / mouse mapping", "鍵盤／滑鼠鍵位", "键盘 / 鼠标映射"],
	"屏幕按键已开启": ["On-screen controls enabled.", "已開啟螢幕按鍵。", "屏幕按键已开启"],
	"屏幕按键已关闭": ["On-screen controls disabled.", "已關閉螢幕按鍵。", "屏幕按键已关闭"],
	"已结束 NAS 上的会话": ["The NAS session has ended.", "已結束 NAS 上的工作階段。", "已结束 NAS 上的会话"],
	"让 PS5 进入待机？": ["Put the PS5 in rest mode?", "讓 PS5 進入待命模式？", "让 PS5 进入待机？"],
	"主机会切到休息模式，串流会断开。下次回来点「唤醒」就行。": ["The console will enter rest mode and disconnect the stream. Select Wake to use it again.", "主機將進入待命模式並中斷串流。下次使用時請選擇「喚醒」。", "主机会切到休息模式，串流会断开。下次回来点「唤醒」就行。"],
	"已发送待机命令": ["Rest mode command sent.", "已送出待命指令。", "已发送待机命令"],
	"视图被放大了 · 点此还原": ["View zoomed in · Reset", "畫面已放大 · 點此還原", "视图被放大了 · 点此还原"],
	"正在看看有没有人在玩…": ["Checking for a live stream…", "正在查看是否有直播…", "正在看看有没有人在玩…"],
	"刷新": ["Refresh", "重新整理", "刷新"],
	"我要操控": ["Take control", "接手操控", "我要操控"],
	"管理": ["Manage", "管理", "管理"],
	"更换昵称": ["Change nickname", "更改暱稱", "更换昵称"],
	"表情": ["Emoji", "表情符號", "表情"],
	"发个弹幕…": ["Write a chat message…", "輸入聊天訊息…", "发个弹幕…"],
	"发送": ["Send", "傳送", "发送"],
	"挑个昵称发弹幕": ["Choose a nickname to chat", "選擇暱稱以開始聊天", "挑个昵称发弹幕"],
	"或自定义一个…": ["Or enter your own…", "或自行輸入…", "或自定义一个…"],
	"就用这个": ["Use this nickname", "使用這個暱稱", "就用这个"],
	"选好后可随时点弹幕栏左侧的昵称更换": ["Select your nickname next to the chat box to change it anytime.", "隨時可點選聊天欄旁的暱稱進行更改。", "选好后可随时点弹幕栏左侧的昵称更换"],
	"操控需要密码，输入访问密码解锁。": ["Enter the access password to take control.", "輸入存取密碼以接手操控。", "操控需要密码，输入访问密码解锁。"],
	"访问密码": ["Access password", "存取密碼", "访问密码"],
	"解锁操控": ["Unlock controls", "解鎖操控", "解锁操控"],
	"返回观战": ["Back to watching", "返回觀看", "返回观战"],
	"日志": ["Logs", "記錄", "日志"],
	"退出": ["Log out", "登出", "退出"],
	"NAS 上还有一个正在进行的串流": ["A stream is still running on the NAS", "NAS 上仍有進行中的串流", "NAS 上还有一个正在进行的串流"],
	"可能是刷新前的页面留下的。直接接入就能继续玩，不用重新唤醒主机。": ["This may be from before you refreshed. Rejoin to continue without waking the console again.", "這可能是重新整理前留下的串流。直接加入即可繼續遊玩，無須再次喚醒主機。", "可能是刷新前的页面留下的。直接接入就能继续玩，不用重新唤醒主机。"],
	"结束它": ["End session", "結束工作階段", "结束它"],
	"继续接入": ["Rejoin", "重新加入", "继续接入"],
	"我的主机": ["My consoles", "我的主機", "我的主机"],
	"还没有主机。可以点「扫描局域网」，或者手动填 PS5 的 IP 添加。": ["No consoles yet. Scan your local network or enter your PS5’s IP address manually.", "尚未新增主機。請掃描區域網路，或手動輸入 PS5 的 IP 位址。", "还没有主机。可以点「扫描局域网」，或者手动填 PS5 的 IP 添加。"],
	"局域网里发现": ["Found on your network", "在區域網路上找到的主機", "局域网里发现"],
	"手动添加": ["Add manually", "手動新增", "手动添加"],
	"PS5 的 IP，例如 192.168.1.50": ["PS5 IP address, e.g. 192.168.1.50", "PS5 IP 位址，例如 192.168.1.50", "PS5 的 IP，例如 192.168.1.50"],
	"备注名（可选）": ["Display name (optional)", "顯示名稱（選填）", "备注名（可选）"],
	"添加": ["Add", "新增", "添加"],
	"使用前提": ["Requirements", "使用條件", "使用前提"],
	"PS5 已开启「设置 → 系统 → 远程游玩 → 启用远程游玩」。": ["On your PS5, go to Settings → System → Remote Play → Enable Remote Play.", "在 PS5 上前往「設定 → 系統 → 遙控遊玩 → 啟用遙控遊玩」。", "PS5 已开启「设置 → 系统 → 远程游玩 → 启用远程游玩」。"],
	"NAS 和 PS5 在同一个局域网；NAS 的 Docker 用 host 网络（发现和串流都靠 UDP）。": ["The NAS and PS5 must be on the same local network. Docker on the NAS must use host networking because discovery and streaming use UDP.", "NAS 和 PS5 必須位於同一區域網路。NAS 上的 Docker 必須使用 host 網路模式，因為探索和串流皆使用 UDP。", "NAS 和 PS5 在同一个局域网；NAS 的 Docker 用 host 网络（发现和串流都靠 UDP）。"],
	"首次使用要在 PS5 上「关联设备」拿到 8 位 PIN，再配合 PSN Account-ID 配对一次。": ["For first-time setup, select Link Device on your PS5 and pair using the 8-digit PIN and your PSN Account ID.", "首次使用時，請在 PS5 選擇「連結裝置」，使用 8 位數 PIN 和 PSN 帳戶 ID 配對。", "首次使用要在 PS5 上「关联设备」拿到 8 位 PIN，再配合 PSN Account-ID 配对一次。"],
	"放大全屏": ["Expand to fullscreen", "放大至全螢幕", "放大全屏"],
	"⛶ 放大": ["⛶ Expand", "⛶ 放大", "⛶ 放大"],
	"声音": ["Audio", "聲音", "声音"],
	"屏幕按键": ["On-screen controls", "螢幕按鍵", "屏幕按键"],
	"键盘映射": ["Keyboard mapping", "鍵盤鍵位", "键盘映射"],
	"全屏": ["Fullscreen", "全螢幕", "全屏"],
	"让 PS5 待机": ["Put PS5 in rest mode", "讓 PS5 進入待命模式", "让 PS5 待机"],
	"结束串流": ["Stop streaming", "結束串流", "结束串流"],
	"退出全屏观看": ["Exit fullscreen viewing", "離開全螢幕觀看", "退出全屏观看"],
	"滑动＝滑动触摸板 · 轻点＝按下": ["Swipe to move on the touchpad · Tap to press", "滑動＝操作觸控板 · 輕觸＝按下", "滑动＝滑动触摸板 · 轻点＝按下"],
	"如果主机在待机，请先点「唤醒」。": ["If the console is in rest mode, select Wake first.", "如果主機處於待命模式，請先選擇「喚醒」。", "如果主机在待机，请先点「唤醒」。"],
	"点击启用声音": ["Tap to enable audio", "點一下以開啟聲音", "点击启用声音"],
	"操作失败，请查看日志。": ["The operation failed. Check the browser console for details.", "操作失敗，請查看瀏覽器主控台。", "操作失败，请查看浏览器控制台。"],
	"语言": ["Language", "語言", "语言"],
	"当前是 http 访问，浏览器禁用了 WebCodecs 和手柄 API。": ["HTTP disables WebCodecs and controller APIs.", "HTTP 會停用 WebCodecs 和控制器 API。", "当前是 http 访问，浏览器禁用了 WebCodecs 和手柄 API。"],
	"1. 在 PS5 上打开「设置 → 系统 → 远程游玩 → 关联设备」，屏幕会显示 8 位 PIN。": ["1. On PS5, go to Settings → System → Remote Play → Link Device to see the 8-digit PIN.", "1. 在 PS5 前往「設定 → 系統 → 遙控遊玩 → 連結裝置」，查看 8 位數 PIN。", "1. 在 PS5 上打开「设置 → 系统 → 远程游玩 → 关联设备」，屏幕会显示 8 位 PIN。"],
	"2. 用电脑或手机打开 psn.flipscreen.games，登录后复制 Account-ID（base64 那串）。": ["2. Open psn.flipscreen.games, sign in, and copy the Base64 Account ID.", "2. 開啟 psn.flipscreen.games，登入後複製 Base64 帳戶 ID。", "2. 用电脑或手机打开 psn.flipscreen.games，登录后复制 Account-ID（base64 那串）。"],
	"码率越高画质越好，但上行带宽要跟上。远程玩建议 12–18 Mbps。选完会记住，下次默认还是这套。": ["Higher bitrates improve quality but need more upload bandwidth. Try 12–18 Mbps for remote play. Settings are saved for next time.", "較高的位元率可改善畫質，但需要更多上傳頻寬。遠端遊玩建議使用 12–18 Mbps。設定會儲存供下次使用。", "码率越高画质越好，但上行带宽要跟上。远程玩建议 12–18 Mbps。选完会记住，下次默认还是这套。"],
	"改完立刻生效，只存在这台设备上。摇杆在下方，十字键和面板键在各自摇杆的正上方。": ["Changes apply immediately on this device only. The D-pad and face buttons sit above their respective sticks.", "變更會立即生效，且只儲存在此裝置。方向鍵和面板按鍵位於各自的搖桿上方。", "改完立刻生效，只存在这台设备上。摇杆在下方，十字键和面板键在各自摇杆的正上方。"],
	"手柄震动会同时带动手机振一下（幅度没法调，只能用长短区分）。": ["Controller rumble also vibrates your phone. Only the duration can vary.", "控制器震動時，手機也會震動。只能調整震動時間。", "手柄震动会同时带动手机振一下（幅度没法调，只能用长短区分）。"],
	"iPhone 的浏览器没有震动 API（WebKit 从没实现），这里用屏幕边缘的柔光代替。": ["iPhone browsers lack the Vibration API, so the screen edges glow instead.", "iPhone 瀏覽器不支援震動 API，因此改以螢幕邊緣發光提示。", "iPhone 的浏览器没有震动 API（WebKit 从没实现），这里用屏幕边缘的柔光代替。"],
	"主机在待机的话会自动唤醒，冷启动大概 30–60 秒。": ["A console in rest mode wakes automatically. Allow about 30–60 seconds.", "待命中的主機會自動喚醒，約需 30–60 秒。", "主机在待机的话会自动唤醒，冷启动大概 30–60 秒。"],
	"选「接入」继续这个会话，或「结束旧的重开」。": ["Select Join to continue, or Stop and restart.", "選擇「加入」以繼續，或選擇「結束後重新開始」。", "选「接入」继续这个会话，或「结束旧的重开」。"],
	"可能是另一个标签页／设备，也可能是你刚刷新过页面。直接接入可以继续用同一个会话，不需要重新唤醒 PS5。": ["This session may be from another tab, another device, or before a refresh. Join without waking the PS5 again.", "此工作階段可能來自其他分頁、裝置，或重新整理前的頁面。加入時無須再次喚醒 PS5。", "可能是另一个标签页／设备，也可能是你刚刷新过页面。直接接入可以继续用同一个会话，不需要重新唤醒 PS5。"],
	"主机不会被重新唤醒，画面应该几秒内就回来。": ["The console will not be woken again. Video should return within a few seconds.", "主機不會再次喚醒，畫面應在幾秒內恢復。", "主机不会被重新唤醒，画面应该几秒内就回来。"],
	"这个会话可能已经断了。点下面的按钮结束它，再回上一页重新开始串流。": ["The session may have disconnected. End it below, then go back and start streaming again.", "工作階段可能已中斷。請在下方結束，再返回上一頁重新開始串流。", "这个会话可能已经断了。点下面的按钮结束它，再回上一页重新开始串流。"],
	"这个浏览器没有 WebCodecs，请换成 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+。": ["This browser lacks WebCodecs. Try Chrome or Edge 94+, Safari 16.4+, or Firefox 130+.", "此瀏覽器不支援 WebCodecs。請使用 Chrome 或 Edge 94+、Safari 16.4+ 或 Firefox 130+。", "这个浏览器没有 WebCodecs，请换成 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+。"],
	"这个浏览器不支持 WebCodecs，请用 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+": ["This browser lacks WebCodecs. Try Chrome or Edge 94+, Safari 16.4+, or Firefox 130+.", "此瀏覽器不支援 WebCodecs。請使用 Chrome 或 Edge 94+、Safari 16.4+ 或 Firefox 130+。", "这个浏览器不支持 WebCodecs，请用 Chrome / Edge 94+、Safari 16.4+ 或 Firefox 130+"],
	"当前是 http 页面，浏览器只在 HTTPS 或 localhost 下开放 WebCodecs。换成 https 打开，或把本站加进 Chrome 的 insecure-origin 白名单。": ["WebCodecs requires HTTPS or localhost. Use HTTPS or add this site to Chrome’s insecure-origin allowlist.", "WebCodecs 需要 HTTPS 或 localhost。請使用 HTTPS，或將網站加入 Chrome 的不安全來源允許清單。", "当前是 http 页面，浏览器只在 HTTPS 或 localhost 下开放 WebCodecs。换成 https 打开，或把本站加进 Chrome 的 insecure-origin 白名单。"],
	"当前是 http 页面，浏览器禁用了 WebCodecs（会黑屏）。请用 https 打开本站。": ["HTTP disables WebCodecs, so video will be blank. Open this site over HTTPS.", "HTTP 會停用 WebCodecs，導致黑畫面。請使用 HTTPS 開啟網站。", "当前是 http 页面，浏览器禁用了 WebCodecs（会黑屏）。请用 https 打开本站。"],
	"回上一页点「开始串流」重新连一次。": ["Go back and select Start streaming to reconnect.", "返回上一頁，選擇「開始串流」以重新連線。", "回上一页点「开始串流」重新连一次。"],
	"主机在待机，已发唤醒包，冷启动大约 30 秒，别关页面。": ["Wake packet sent. Keep this page open for about 30 seconds while the console wakes.", "已送出喚醒封包。請保持頁面開啟，等待主機喚醒（約 30 秒）。", "主机在待机，已发唤醒包，冷启动大约 30 秒，别关页面。"],
	"上次的 PIN 不正确。请重新查看 PS5 屏幕上的「关联设备」PIN。": ["Incorrect PIN. Check the Link Device screen on your PS5 for the current PIN.", "PIN 不正確。請重新查看 PS5「連結裝置」畫面上的 PIN。", "上次的 PIN 不正确。请重新查看 PS5 屏幕上的「关联设备」PIN。"],
	"已进入沉浸模式。iPhone 上要真正的全屏（没有地址栏），请用「分享 → 添加到主屏幕」，从图标打开。": ["Immersive mode is on. On iPhone, use Share → Add to Home Screen and launch the icon for fullscreen without the address bar.", "已進入沉浸模式。在 iPhone 上，請選擇「分享 → 加入主畫面」，再從圖示啟動以使用無網址列的全螢幕模式。", "已进入沉浸模式。iPhone 上要真正的全屏（没有地址栏），请用「分享 → 添加到主屏幕」，从图标打开。"],
	"系统不允许网页全屏，已切换到沉浸模式：": ["Fullscreen was unavailable; switched to immersive mode: ", "無法進入全螢幕，已切換至沉浸模式：", "系统不允许网页全屏，已切换到沉浸模式："],
	"处理 = 从浏览器收到这一帧到画到屏幕（纯本地时钟，最可信）": ["Processing = from browser receipt to rendering (local clock)", "處理＝瀏覽器收到影格至顯示（本機時鐘）", "处理 = 从浏览器收到这一帧到画到屏幕（纯本地时钟，最可信）"],
	"传输 = 帧从 NAS 到你浏览器（依赖两边时钟同步，仅供参考）": ["Transfer = from NAS to browser (estimate depends on clock sync)", "傳輸＝NAS 至瀏覽器（估算值取決於時鐘同步）", "传输 = 帧从 NAS 到你浏览器（依赖两边时钟同步，仅供参考）"],
	"RTT = 往返时延；队列 = 待解码帧数": ["RTT = round-trip time; queue = frames awaiting decoding", "RTT＝來回延遲；佇列＝等待解碼的影格數", "RTT = 往返时延；队列 = 待解码帧数"],
	"：": [": ", "：", "："],
	"nicknameSet": ["Nickname set to “{0}”.", "暱稱已設定為「{0}」。", "昵称已设置为「{0}」"],
	"viewers": ["Viewers: {0}", "{0} 人正在觀看", "{0} 人在看"],
	"roomFull": ["The stream is full ({0}). Keep this page open to join when a spot opens…", "觀看人數已滿（{0}）。請保持頁面開啟，有空位時會自動加入…", "当前观看人数已满（{0}），有人离开后会自动接入，别关页面…"],
	"deleteCredentials": ["This will also delete the saved pairing credentials for {0}.", "這也會刪除 {0} 的已儲存配對憑證。", "会同时删除已保存的配对凭据：{0}"],
	"pairConsole": ["Pair {0}", "配對 {0}", "配对 {0}"],
	"startConsole": ["Start streaming · {0}", "開始串流 · {0}", "开始串流 · {0}"],
	"processing": ["Processing {0} ms", "處理 {0} ms", "处理 {0} ms"],
	"transfer": ["Transfer {0} ms", "傳輸 {0} ms", "传输 {0} ms"],
	"queue": ["Queue {0}", "佇列 {0}", "队列 {0}"],
	"decoder": ["Decoder: {0}; keyframe skips: {1}", "解碼器：{0}；略過關鍵影格次數：{1}", "解码器: {0}，跳过关键帧次数: {1}"],
	"httpHelp": ["Video and controllers may not work. Use HTTPS, or add {0} to chrome://flags/#unsafely-treat-insecure-origin-as-secure and restart Chrome.", "畫面和控制器可能無法使用。請透過 HTTPS 開啟，或在 chrome://flags/#unsafely-treat-insecure-origin-as-secure 中加入 {0}，然後重新啟動 Chrome。", "画面可能黑屏，手柄可能不可用。请用 HTTPS 打开本站，或在 chrome://flags/#unsafely-treat-insecure-origin-as-secure 中添加 {0}，然后重启浏览器。"],
};

const presetNicknames = [["Happy Pad", "Couch Player", "Night Owl", "Button Masher", "Popcorn Fan", "Player One", "Break Time", "Rookie Hero", "Highlight Reel", "Nap First", "Moon Shadow", "Sleepy Fish", "Fish Burger", "Next Door", "Cat Champion", "Blacksmith", "Fog Walker", "No Cilantro", "Cookie", "Chill Champ", "Night Diner", "Player Two", "Flying Fish", "Coo Coo", "Grand Marshal", "Ice Breaker", "Hype Captain", "Cheer Squad", "Anonymous", "Game Wanderer", "Big Fan", "Well Played", "Snack Break", "Here for Fun", "Player Three", "Break Buddy", "Lucky Teammate", "Quick Study", "Big Talk", "New Arrival"], ["快樂手把", "沙發玩家", "今晚不睡", "手殘玩家", "看熱鬧的觀眾", "路人甲", "摸魚大師", "新手英雄", "精彩製造機", "先睡個午覺", "月影玩家", "一條鹹魚", "麥香魚", "隔壁老王", "貓咪無雙", "打鐵路人", "霧中旅人", "不吃香菜", "小餅乾", "放空冠軍", "深夜食堂", "路人乙", "會飛的魚", "咕咕咕", "大司馬", "冷場救星", "氣氛組長", "專業捧哏", "無名氏", "遊戲人間", "超級粉絲", "太厲害了", "配飯操作", "看戲玩家", "路人丙", "摸魚選手", "幸運隊友", "偷學兩招", "嘴強王者", "新手報到"], ["快乐手柄", "沙发玩家", "今晚不睡", "手残党本党", "吃瓜观众", "路人甲", "摸鱼大师", "菜到抠脚", "高光制造机", "睡个午觉先", "风灵月影宗", "一只咸鱼", "麦香鱼", "隔壁老王", "猫才无双", "打铁的路人", "雾都孤儿", "不吃香菜", "小饼干", "摆烂冠军", "深夜食堂", "路人乙", "会飞的鱼", "咕咕咕", "大司马本马", "冷场担当", "气氛组组长", "专业捧哏", "无名氏", "游戏人间", "一整个爱住", "太会了叭", "下饭操作", "乐子人", "路人丙", "摸鱼选手", "躺分玩家", "偷学两招", "嘴强王者", "萌新报道"]];

export function t(key, ...args) {
	const value = Object.hasOwn(messages, key) ? messages[key][locales.indexOf(locale)] : key;
	return value.replace(/\{(\d+)\}/g, (match, index) => String(args[index] ?? match));
}

export function nicknames() {
	return presetNicknames[locales.indexOf(locale)];
}

export function localizedError(error) {
	console.warn('[ps5web]', error);
	return t('操作失败，请查看日志。');
}

export function initLocale() {
	document.documentElement.lang = locale;
	// Translate the upstream HTML before any user or server content is rendered.
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.parentElement.closest('script, style')) continue;
		const original = node.nodeValue.trim();
		if (Object.hasOwn(messages, original)) node.nodeValue = node.nodeValue.replace(original, t(original));
	}
	for (const element of document.querySelectorAll('[title], [placeholder]')) {
		for (const attr of ['title', 'placeholder']) {
			if (element.hasAttribute(attr)) element.setAttribute(attr, t(element.getAttribute(attr)));
		}
	}
	for (const parent of document.querySelectorAll('.watch-actions, #view-home .topbar .row')) {
		const select = document.createElement('select');
		select.setAttribute('aria-label', t('语言'));
		for (const [index, label] of ['English', '繁體中文', '简体中文'].entries()) {
			const option = document.createElement('option');
			option.value = option.lang = locales[index];
			option.textContent = label;
			select.append(option);
		}
		select.value = locale;
		select.addEventListener('change', () => {
			if (!locales.includes(select.value)) return;
			try {
				localStorage.setItem(storageKey, select.value);
			} catch {
				select.value = locale;
				return;
			}
			// Reload so already-rendered dialogs and status labels use the same locale.
			location.reload();
		});
		parent.append(select);
	}
}
