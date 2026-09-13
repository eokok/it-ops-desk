/* ============================================================
   IT 智能助手 — 故障诊断工作流 + 新员工入职指引
   ============================================================ */
window.OpsBotFlows = (() => {
  "use strict";

  /* ============================================================
     1. 故障诊断工作流（决策树）
     节点类型：
       choice  单选题，按选项跳转
       result  结论节点，level = self(自助解决) / diag(继续诊断) / ticket(转人工工单)
     ============================================================ */
  const FLOWS = [
    /* ---------------- 网络连通性 ---------------- */
    {
      id: "net", name: "网络连通性诊断", cat: "网络", sla: "P2", icon: "🌐",
      intro: "我将带你按「物理层 → 地址层 → 解析层 → 应用层」逐步排查，约 1 分钟。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "你的电脑是怎么联网的？", options: [
          { label: "网线（有线）", next: "n_wired" },
          { label: "Wi-Fi（无线）", next: "n_wifi" },
        ] },
        n_wifi: { type: "result", level: "diag", title: "无线场景建议走「无线网络诊断」",
          text: "无线掉线/连不上与有线排查路径不同，用专用流程更准。",
          steps: ["在下方选择「无线网络诊断」流程；", "若为完全搜不到信号，请记录位置与 AP 编号后报障。"],
          pri: "P2", cat: "网络", swipe: "wifi" },
        n_wired: { type: "choice", q: "电脑网口旁的指示灯亮或闪烁吗？（网线插入主机那一侧的灯）", hint: "不亮通常是线缆或网口问题", options: [
          { label: "亮或闪烁", next: "n_ip" },
          { label: "完全不亮", next: "n_cable" },
          { label: "没有指示灯 / 看不到", next: "n_ip" },
        ] },
        n_cable: { type: "result", level: "self", title: "物理链路不通：网线或网口故障",
          text: "指示灯不亮说明链路层就没有建立，先做物理替换即可定位。",
          steps: [
            "换一根确认可用的网线重试；",
            "换墙上的另一个网口（或换交换机端口）；",
            "确认网线两端都已插到底（有轻微「咔」声）；",
            "换线换口后灯仍不亮，提交工单，注明「工位 XX，网口指示不亮」。",
          ], pri: "P3", cat: "网络" },
        n_ip: { type: "choice", q: "打开命令提示符执行 ipconfig，IPv4 地址是什么开头？", hint: "开始菜单搜索 cmd 即可打开", options: [
          { label: "169.254.x.x", next: "n_dhcp" },
          { label: "10.x 或 192.168.x 等正常网段", next: "n_ping" },
          { label: "没有显示 IPv4 地址", next: "n_dhcp" },
        ] },
        n_dhcp: { type: "result", level: "self", title: "未获取到有效 IP（DHCP 失败）",
          text: "169.254 开头是系统自动分配的临时地址，代表没有拿到 DHCP 响应。",
          steps: [
            "确认网卡设置为「自动获得 IP 地址」（若曾手设固定 IP，改回自动）；",
            "以管理员身份运行 cmd，依次执行：ipconfig /release、ipconfig /renew；",
            "更换交换机端口后重试（该端口 DHCP 中继可能异常）；",
            "重启网卡：网络连接 → 右键以太网 → 禁用 → 再启用；",
            "以上无效提交工单，附 ipconfig /all 的完整输出。",
          ], pri: "P2", cat: "网络" },
        n_ping: { type: "choice", q: "执行 ping 10.0.0.1（内网网关）通不通？", hint: "有「来自 10.0.0.1 的回复」即为通", options: [
          { label: "能通，有回复", next: "n_dns" },
          { label: "不通，请求超时", next: "n_gateway" },
        ] },
        n_gateway: { type: "result", level: "diag", title: "网关不可达：链路或 VLAN 配置问题",
          text: "本机已拿到地址但出不了网关，通常是接入端口 VLAN 或上联链路异常。",
          steps: [
            "先换交换机端口 / 换工位复测，排除单端口故障；",
            "确认没有手工配置过错误的网关地址；",
            "如仅你一人异常，多为端口问题；多人同时异常则是链路或 VLAN 故障；",
            "建议提交工单并注明网关地址与工位位置。",
          ], pri: "P2", cat: "网络", ticketTitle: "网关不可达（工位网络异常）" },
        n_dns: { type: "choice", q: "执行 ping www.baidu.com 能否解析出 IP？", options: [
          { label: "能解析出 IP 地址", next: "n_scope" },
          { label: "提示找不到主机 / 解析失败", next: "n_dnsfix" },
        ] },
        n_dnsfix: { type: "result", level: "self", title: "DNS 解析异常",
          text: "IP 层通、域名不通，基本可确定是 DNS 问题。",
          steps: [
            "执行 ipconfig /flushdns 清空 DNS 缓存；",
            "将网卡 DNS 改为「自动获得」，或按 IT 公告填写内网 DNS；",
            "清理浏览器 DNS 缓存：访问 chrome://net-internals/#dns → Clear host cache；",
            "重启网卡后重试；",
            "多名同事同时出现，请提交工单（可能是内网 DNS 服务异常）。",
          ], pri: "P2", cat: "网络" },
        n_scope: { type: "choice", q: "是「所有网站都打不开」还是「只有部分系统打不开」？", options: [
          { label: "所有都打不开", next: "r_global" },
          { label: "只有部分系统 / 网站打不开", next: "r_partial" },
        ] },
        r_global: { type: "result", level: "ticket", title: "网络可达但应用全不可用，建议转人工",
          text: "网关与 DNS 都正常，但仍无法访问任何应用，需要网络运维检查出口策略与代理。",
          steps: ["确认本机未开启代理软件（设置 → 代理 → 关闭自动检测）"],
          pri: "P2", cat: "网络", ticketTitle: "内网可达但应用无法访问（疑似出口策略异常）" },
        r_partial: { type: "result", level: "self", title: "局部访问受限：多为策略或系统侧问题",
          text: "只有部分目标不可达，通常是访问策略限制或对端系统异常。",
          steps: [
            "用无痕窗口重试，并清一次浏览器缓存；",
            "确认该系统的同事能否访问：同事可以 → 你本机网络/账号问题；同事也不行 → 系统侧故障；",
            "查看状态页 http://status.corp.example.com 是否有故障公告；",
            "属业务需要但被策略拦截，提交「上网权限申请」。",
          ], pri: "P3", cat: "网络", ticketTitle: "特定内部系统无法访问" },
      },
    },

    /* ---------------- 无线网络 ---------------- */
    {
      id: "wifi", name: "无线网络诊断", cat: "网络", sla: "P2", icon: "📶",
      intro: "先区分「单设备问题」还是「区域覆盖问题」，这决定后续处理路径。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "用手机连同一个 Wi-Fi，是否正常？", options: [
          { label: "手机正常，只有电脑异常", next: "n_dev" },
          { label: "手机也异常", next: "n_area" },
        ] },
        n_dev: { type: "choice", q: "在电脑上「忘记此网络」后重新连接，是否恢复正常？", options: [
          { label: "恢复正常了", next: "r_done" },
          { label: "还是不行", next: "n_band" },
        ] },
        n_band: { type: "choice", q: "改连 5G 频段 SSID（名称后缀 -5G）是否更稳定？", hint: "2.4G 频段干扰大，5G 更稳但穿墙弱", options: [
          { label: "更稳定了", next: "r_band" },
          { label: "同样掉线", next: "n_drv" },
        ] },
        n_drv: { type: "result", level: "self", title: "单设备侧问题：无线驱动或电源策略",
          text: "其他设备正常说明 AP 没问题，问题集中在你的网卡驱动与省电策略。",
          steps: [
            "更新无线网卡驱动（设备管理器 → 网络适配器 → 更新驱动，或从软件中心安装厂商驱动）；",
            "关闭网卡省电：网卡属性 → 电源管理 → 取消「允许计算机关闭此设备以节约电源」；",
            "关闭「随机硬件地址」（设置 → 网络 → Wi-Fi → 随机硬件地址 → 关闭）；",
            "取消勾选「仅允许首选网络」，删除所有历史 SSID 后重连；",
            "仍无效提交工单，附网卡型号与驱动版本。",
          ], pri: "P3", cat: "网络" },
        n_area: { type: "choice", q: "是「在某个位置才掉线」还是「全公司范围都连不上」？", options: [
          { label: "特定位置才掉线", next: "r_area" },
          { label: "大范围都不正常", next: "r_global" },
        ] },
        r_done: { type: "result", level: "self", title: "已恢复（网络配置缓存问题）",
          text: "「忘记网络后重连」清掉了失效的配置文件，属于常见问题。",
          steps: ["建议同时更新一次无线网卡驱动，降低复发概率。", "若反复出现同样问题，可提交工单做深度排查。"],
          pri: "P4", cat: "网络" },
        r_band: { type: "result", level: "self", title: "建议固定使用 5G 频段",
          text: "2.4G 频段信道拥挤（微波炉、蓝牙、邻区 AP 都会干扰）。",
          steps: [
            "办公区优先连接 -5G 后缀的 SSID；",
            "若 5G 信号弱（距离 AP 较远），说明覆盖不足，可提交工单申请补点。",
          ], pri: "P4", cat: "网络" },
        r_area: { type: "result", level: "ticket", title: "局部区域掉线：疑似 AP 覆盖或故障",
          text: "特定位置掉线通常意味着该区域 AP 信号弱或设备异常。",
          steps: ["记录持续掉线的具体位置（楼层 + 区域 + 最近 AP 编号，AP 编号一般在吊顶设备标签上）"],
          pri: "P3", cat: "网络", ticketTitle: "无线覆盖不足 / AP 故障（局部区域掉线）" },
        r_global: { type: "result", level: "ticket", title: "大范围无线异常：建议立即转人工",
          text: "多设备、多区域同时异常，可能是无线控制器或上联链路故障，影响面较大。",
          steps: ["先尝试切换有线网络保障办公，同时立即报障。"],
          pri: "P1", cat: "网络", ticketTitle: "大范围无线网络中断（疑似无线控制器故障）" },
      },
    },

    /* ---------------- 终端性能 ---------------- */
    {
      id: "slow", name: "终端性能诊断（慢/卡）", cat: "终端", sla: "P3", icon: "⚡",
      intro: "卡顿的根因通常在启动项、磁盘或资源占用三类，逐一排除即可定位。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "卡顿主要出现在什么场景？", options: [
          { label: "开机阶段特别慢", next: "r_boot" },
          { label: "使用中随机卡顿", next: "n_usage" },
          { label: "只有某个软件卡", next: "r_app" },
        ] },
        r_boot: { type: "result", level: "self", title: "开机慢：启动项与开机自启服务过多",
          text: "开机慢绝大多数由自启动程序堆积导致，禁用后可显著改善。",
          steps: [
            "Ctrl+Shift+Esc 打开任务管理器 → 启动 选项卡；",
            "禁用非必要项（保留杀毒、输入法、企业微信、VPN）；",
            "关闭「快速启动」有时反而更慢，可尝试开启或关闭做对比；",
            "检查磁盘是否接近写满（>90%），清理下载目录与临时文件；",
            "机械硬盘机型开机慢属硬件瓶颈，建议申请更换 SSD。",
          ], pri: "P3", cat: "终端" },
        n_usage: { type: "choice", q: "打开任务管理器，看「性能」页，哪一项长期接近 100%？", options: [
          { label: "磁盘（Disk）", next: "n_disk" },
          { label: "CPU 或 内存", next: "n_cpu" },
          { label: "都正常（都不超 70%）", next: "n_virus" },
        ] },
        n_disk: { type: "choice", q: "系统盘（C 盘）剩余空间是否低于 10%？", options: [
          { label: "是，快满了", next: "r_space" },
          { label: "不是，空间还很充足", next: "n_hdd" },
        ] },
        r_space: { type: "result", level: "self", title: "系统盘空间不足导致严重卡顿",
          text: "磁盘剩余空间低于 10% 时，虚拟内存与临时文件交换会显著拖慢系统。",
          steps: [
            "清理：设置 → 系统 → 存储 → 临时文件，删除下载、回收站与更新缓存；",
            "把个人大文件迁移到共享盘或网盘，不要放在 C 盘；",
            "将「下载」「文档」等目录的默认位置改到其他分区；",
            "目标：C 盘保留至少 15% 空闲空间。",
          ], pri: "P3", cat: "终端" },
        n_hdd: { type: "choice", q: "你的机器硬盘是机械硬盘（HDD）还是固态（SSD）？", hint: "任务管理器 → 性能 → 磁盘，会标注类型", options: [
          { label: "机械硬盘 HDD", next: "r_ssd" },
          { label: "固态硬盘 SSD", next: "n_virus" },
        ] },
        r_ssd: { type: "result", level: "self", title: "机械硬盘性能瓶颈，建议升级 SSD",
          text: "机械硬盘随机读写能力有限，磁盘占用 100% 是典型症状，软件优化效果有限。",
          steps: [
            "提交「设备升级」工单申请更换 SSD（建议 512GB 起）；",
            "升级时 IT 会做系统迁移，数据不丢失；",
            "过渡期可先关闭系统索引服务与磁盘碎片整理计划任务缓解。",
          ], pri: "P4", cat: "终端", ticketTitle: "申请将机械硬盘升级为 SSD" },
        n_cpu: { type: "result", level: "self", title: "CPU / 内存被占满：定位异常进程",
          text: "任务管理器「进程」页按 CPU / 内存排序，即可看到元凶。",
          steps: [
            "任务管理器 → 进程 → 点击「CPU」或「内存」列标题排序；",
            "识别非工作所需的高占用程序并结束任务；",
            "浏览器标签页过多也会吃满内存，建议限制在 15 个以内或使用标签休眠；",
            "内存长期 90%+ 且是 8GB 机型，可提交工单申请扩容至 16GB；",
            "出现不明进程且名称随机（如一堆乱码字母），请按「电脑中毒」流程处理。",
          ], pri: "P3", cat: "终端" },
        r_app: { type: "result", level: "self", title: "单一软件卡顿：该软件自身问题",
          text: "若只有某个软件卡，问题一般不在系统层。",
          steps: [
            "升级该软件到最新版本；",
            "清理该软件的本地缓存目录；",
            "关闭该软件内的硬件加速选项后再试；",
            "若为业务系统，确认是否服务端响应慢（找同事对比操作同一功能）；",
            "属于公司采购软件的兼容问题，可提交工单由 IT 协调厂商。",
          ], pri: "P4", cat: "终端" },
        n_virus: { type: "result", level: "diag", title: "资源占用正常，需排查恶意程序或系统异常",
          text: "各项指标都不高但用户感知卡顿，需做一次安全与系统层检查。",
          steps: [
            "用公司提供的杀毒软件做一次全盘扫描；",
            "检查是否开启了某些后台同步工具（网盘、备份软件持续占用 IO）；",
            "更新系统补丁与显卡驱动到最新；",
            "如伴随异常弹窗、主页被篡改，按「电脑中毒」应急流程处理；",
            "以上都正常仍明显卡顿，提交工单安排上门检测（可能为内存 / 硬盘硬件老化）。",
          ], pri: "P3", cat: "终端", ticketTitle: "终端性能异常（需上门检测）" },
      },
    },

    /* ---------------- 打印故障 ---------------- */
    {
      id: "print", name: "打印故障诊断", cat: "打印", sla: "P3", icon: "🖨",
      intro: "打印问题按「打印机本身 → 网络/连接 → 打印队列 → 驱动」四层定位。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "你的打印机是怎么连接的？", options: [
          { label: "网络打印机（IP 打印）", next: "n_net" },
          { label: "USB 直连打印机", next: "n_usb" },
        ] },
        n_net: { type: "choice", q: "ping 打印机 IP 能否通？", hint: "打印机 IP 可在面板「网络设置」里查看", options: [
          { label: "能 ping 通", next: "n_queue" },
          { label: "ping 不通", next: "n_offline" },
        ] },
        n_offline: { type: "choice", q: "打印机面板是否正常（有电、不缺纸墨、未显示离线/错误）？", options: [
          { label: "面板正常", next: "r_net" },
          { label: "面板报错或黑屏", next: "r_hw" },
        ] },
        n_usb: { type: "choice", q: "「设备和打印机」里能看到这台打印机吗？", options: [
          { label: "能看到设备", next: "n_queue" },
          { label: "看不到 / 显示未识别", next: "r_usb" },
        ] },
        n_queue: { type: "choice", q: "打印队列里是否有卡住不动的任务？", options: [
          { label: "有卡住的任务", next: "r_clear" },
          { label: "队列是空的", next: "n_spooler" },
        ] },
        n_spooler: { type: "choice", q: "重启 Print Spooler 服务后能否打印？", hint: "services.msc → Print Spooler → 重启", options: [
          { label: "可以打印了", next: "r_done" },
          { label: "仍然不行", next: "n_driver" },
        ] },
        n_driver: { type: "choice", q: "删除后重新添加打印机、并从软件中心装驱动，是否解决？", options: [
          { label: "解决了", next: "r_done" },
          { label: "还是不行", next: "r_ticket" },
        ] },
        r_hw: { type: "result", level: "ticket", title: "打印机硬件异常，建议转人工",
          text: "面板报错或黑屏属于设备自身故障，需要现场处理（可能涉及换机或厂商维修）。",
          steps: ["请记录面板上的错误代码（如 E-5、Paper Jam）与打印机编号。"],
          pri: "P3", cat: "打印", ticketTitle: "打印机硬件故障（面板报错/黑屏）" },
        r_net: { type: "result", level: "diag", title: "打印机在线但网络不可达",
          text: "面板正常却 ping 不通，说明网络配置或接入端口有问题。",
          steps: [
            "在打印机面板确认 IP 与你的电脑在同一网段；",
            "确认打印机网线插好、网口灯正常；",
            "若打印机近期重启过且是 DHCP 获得地址，IP 可能已变化，请重新按新 IP 添加；",
            "建议提交工单为打印机申请固定 IP，避免反复出现。",
          ], pri: "P3", cat: "打印", ticketTitle: "网络打印机不可达（需检查 IP 与接入端口）" },
        r_usb: { type: "result", level: "self", title: "USB 打印机未被识别",
          text: "设备未出现在列表中，通常是线缆、USB 口或驱动缺失。",
          steps: [
            "换 USB 口（优先主机后置口），换一根打印线测试；",
            "打印机开机后再插线，观察是否能自动安装驱动；",
            "从软件中心安装该型号驱动，或安装通用 PCL6 驱动；",
            "设备管理器若有黄色感叹号，卸载设备后重新插拔；",
            "以上无效提交工单（可能为打印机 USB 接口损坏）。",
          ], pri: "P3", cat: "打印" },
        r_clear: { type: "result", level: "self", title: "打印队列卡死，清空后即可恢复",
          text: "这是最常见的打印故障：某个任务异常导致整个队列阻塞。",
          steps: [
            "打开打印队列窗口 → 取消所有文档；",
            "若取消不掉：services.msc 重启 Print Spooler，再清空队列；",
            "彻底清理：停止 Spooler → 清空 C:\\Windows\\System32\\spool\\PRINTERS 内容 → 启动 Spooler；",
            "重新打印时先只发 1 页测试页，确认正常再批量打印。",
          ], pri: "P4", cat: "打印" },
        r_done: { type: "result", level: "self", title: "打印已恢复",
          text: "服务重启或重新添加打印机解决了配置层面的问题。",
          steps: ["建议记录本次处理方式，下次可直接按此操作。"],
          pri: "P4", cat: "打印" },
        r_ticket: { type: "result", level: "ticket", title: "本地排查已穷尽，建议转人工",
          text: "驱动重装后仍无法打印，需要 IT 从打印服务器侧查看日志与队列配置。",
          steps: ["请提供打印机名称、IP、账号与本次报错截图，便于快速定位。"],
          pri: "P3", cat: "打印", ticketTitle: "打印机无法打印（本地排查已穷尽，需检查打印服务器）" },
      },
    },

    /* ---------------- VPN 远程接入 ---------------- */
    {
      id: "vpn", name: "VPN 远程接入诊断", cat: "网络", sla: "P2", icon: "🔐",
      intro: "先定位失败发生在「认证 / 建链 / 访问」哪一阶段，不同阶段原因完全不同。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "故障发生在哪个阶段？", options: [
          { label: "登录认证就失败", next: "n_auth" },
          { label: "认证过了但连不上（一直转圈/超时）", next: "n_conn" },
          { label: "显示已连接，但访问不了内网", next: "n_access" },
        ] },
        n_auth: { type: "choice", q: "用同一个账号能否正常登录 SSO / 邮箱？", options: [
          { label: "SSO 能正常登录", next: "n_mfa" },
          { label: "SSO 也登不上", next: "r_pwd" },
        ] },
        n_mfa: { type: "choice", q: "是否已完成 MFA（双因素认证）绑定？", options: [
          { label: "已绑定且能收到验证码", next: "r_client_ver" },
          { label: "未绑定 / 换手机收不到验证码", next: "r_mfa" },
        ] },
        n_conn: { type: "choice", q: "你当前所在网络是？", options: [
          { label: "公司内网", next: "r_internal" },
          { label: "家庭宽带 / 酒店网络", next: "n_proxy" },
          { label: "手机热点", next: "n_proxy" },
        ] },
        n_proxy: { type: "choice", q: "电脑上是否开着其他代理 / 加速器 / 代理软件？", options: [
          { label: "开着", next: "r_proxy" },
          { label: "没开", next: "r_client_ver" },
        ] },
        n_access: { type: "choice", q: "执行 route print，路由表里是否有内网网段（10.x / 172.x）？", options: [
          { label: "有内网网段路由", next: "n_split" },
          { label: "没有看到内网网段", next: "r_reconnect" },
        ] },
        n_split: { type: "choice", q: "是否开了按域名/应用分流的代理工具？", hint: "分流工具会劫持内网请求，导致连不通", options: [
          { label: "开着分流工具", next: "r_split" },
          { label: "没有", next: "r_ticket" },
        ] },
        r_pwd: { type: "result", level: "self", title: "账号侧问题：先解决域账号登录",
          text: "VPN 用的是域账号，SSO 都登不上说明密码或账号状态有问题。",
          steps: [
            "重置域账号密码（见知识库「忘记域账号密码」）；",
            "若提示账号被锁，等待 30 分钟或联系服务台解锁；",
            "确认账号未过期（外协 / 实习账号常有有效期限制）。",
          ], pri: "P3", cat: "账户" },
        r_mfa: { type: "result", level: "self", title: "MFA 未绑定或验证码通道失效",
          text: "VPN 强制要求 MFA，绑定失效会直接卡在认证阶段。",
          steps: [
            "在 SSO 门户重新绑定认证器 App；",
            "换手机或设备丢失时，致电服务台核验身份后重置 MFA 绑定；",
            "建议同时绑定备用手机号作为验证码兜底通道。",
          ], pri: "P3", cat: "账户", ticketTitle: "MFA 绑定失效，需重置绑定" },
        r_client_ver: { type: "result", level: "self", title: "客户端版本或配置问题",
          text: "账号正常、网络正常却建链失败，最常见原因是客户端版本过旧。",
          steps: [
            "卸载现有 VPN 客户端，从软件中心安装最新版本；",
            "关闭所有代理 / 加速器软件后重连；",
            "删除旧配置后重新导入接入配置；",
            "如客户端提供多个接入点，换一个接入点重试；",
            "仍失败提交工单，附客户端日志与错误码。",
          ], pri: "P2", cat: "网络" },
        r_internal: { type: "result", level: "self", title: "在公司内网通常无需连接 VPN",
          text: "内网环境访问公司系统应走内网直连，连 VPN 反而可能因为路由冲突失败。",
          steps: [
            "断开 VPN，直接访问内网系统验证；",
            "若确实需要访问被隔离网段，请提交工单申请网络策略开通。",
          ], pri: "P4", cat: "网络" },
        r_proxy: { type: "result", level: "self", title: "代理软件与 VPN 隧道冲突",
          text: "代理工具会改写系统路由与端口，与 VPN 隧道互斥。",
          steps: [
            "完全退出代理 / 加速器软件（仅关闭开关不够，需退出进程）；",
            "重置系统代理：设置 → 网络和 Internet → 代理 → 关闭「自动检测设置」与手动代理；",
            "重启 VPN 客户端后重连。",
          ], pri: "P2", cat: "网络" },
        r_reconnect: { type: "result", level: "self", title: "隧道未下发内网路由",
          text: "显示已连接但没有内网路由，说明隧道配置未生效。",
          steps: [
            "断开 VPN → 完全退出客户端进程 → 重新打开并连接；",
            "在客户端设置中确认勾选「使用默认网关」或「转发所有流量」；",
            "如客户端支持「内网网段白名单」，确认已包含 10.0.0.0/8；",
            "重连后再次执行 route print 验证；仍无路由请提交工单。",
          ], pri: "P2", cat: "网络" },
        r_split: { type: "result", level: "self", title: "分流代理劫持了内网请求",
          text: "按域名分流的工具会把内网域名的请求发往公网出口，导致不可达。",
          steps: [
            "在分流工具中把内网域名（*.corp.example.com）加入直连（Direct）规则；",
            "或在使用内网系统期间退出分流工具；",
            "重连 VPN 后验证访问。",
          ], pri: "P2", cat: "网络" },
        r_ticket: { type: "result", level: "ticket", title: "隧道与路由均正常，建议转网络运维",
          text: "本地检查未发现异常，需要从 VPN 网关侧查看会话日志与策略。",
          steps: ["请提供账号、接入点、连接时间与客户端日志，便于网关侧定位。"],
          pri: "P2", cat: "网络", ticketTitle: "VPN 已连接但内网不可达（需查网关侧日志）" },
      },
    },

    /* ---------------- 邮件收发 ---------------- */
    {
      id: "mail", name: "邮件收发诊断", cat: "邮箱", sla: "P2", icon: "✉",
      intro: "先用网页版邮箱做分水岭：网页版正常说明问题在客户端，反之在服务端。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "用浏览器登录网页版邮箱，收发是否正常？", options: [
          { label: "网页版正常", next: "r_client" },
          { label: "网页版同样异常", next: "n_scope" },
        ] },
        n_scope: { type: "choice", q: "是所有邮件都异常，还是只有特定收件人 / 域名异常？", options: [
          { label: "全部邮件都异常", next: "n_cap" },
          { label: "只有特定人 / 域名异常", next: "r_bounce" },
        ] },
        n_cap: { type: "choice", q: "邮箱容量是否已满（设置中查看配额）？", options: [
          { label: "已满或接近满", next: "r_cap" },
          { label: "容量充足", next: "n_bounce" },
        ] },
        n_bounce: { type: "choice", q: "是否收到过系统退信（标题含 Undelivered / 退信）？", options: [
          { label: "收到过退信", next: "r_code" },
          { label: "没有退信，就是收不到 / 发不出", next: "r_ticket" },
        ] },
        r_client: { type: "result", level: "self", title: "客户端配置问题（服务端正常）",
          text: "网页版正常说明服务端与账号都没问题，问题在本机邮件客户端。",
          steps: [
            "删除现有账户后按 IT 公告的参数重新配置（服务器地址、端口、加密方式）；",
            "确认客户端为最新版，旧版对 TLS 协议支持不佳会静默失败；",
            "检查是否被安全软件拦截了 993 / 587 端口；",
            "关闭代理软件后重启客户端；",
            "多次重配仍失败，可先改用网页版办公并提交工单。",
          ], pri: "P3", cat: "邮箱" },
        r_cap: { type: "result", level: "self", title: "邮箱容量已满导致收发中断",
          text: "容量满后新邮件会被退回，表现为「收不到也发不出」。",
          steps: [
            "清空「已删除邮件」文件夹（删除后需再清空一次才释放空间）；",
            "搜索大附件邮件并清理：has:attachment larger:10M；",
            "历史邮件归档到本地 PST 或企业网盘；",
            "清理后配额统计有延迟，约 30 分钟后生效；",
            "业务确需更大容量，提交「邮箱扩容」工单。",
          ], pri: "P3", cat: "邮箱" },
        r_bounce: { type: "result", level: "diag", title: "定向收发异常：多为对方策略或地址错误",
          text: "仅特定收件人异常，通常是对方拒收、地址错误或双方网关策略问题。",
          steps: [
            "核对收件人地址拼写（常见的错漏点：多打空格、域名写错）；",
            "让对方在其垃圾邮件目录中查找，若被误判请对方加白名单；",
            "确认对方是否设置了只接收内部邮件的策略；",
            "我方被对方拉黑时，可提交工单由邮件运维协助申诉；",
            "附件超过 50MB 会被拒收，改用网盘外链。",
          ], pri: "P3", cat: "邮箱", ticketTitle: "特定收件人邮件收发异常（需核查网关策略）" },
        r_code: { type: "result", level: "self", title: "依据退信代码定位问题",
          text: "退信代码是判断根因最直接的依据，先看代码再决定处理路径。",
          steps: [
            "550 / 551：对方拒收，多为地址无效或被列黑，可电话核实对方地址；",
            "552：附件或邮件体积超限，改用网盘链接；",
            "554：被判定为垃圾邮件，需对方加白或我方提升发信信誉；",
            "421 / 4xx：临时性错误，稍后重试通常可恢复；",
            "含错误码的退信请保留并提交工单，由邮件运维进一步核查。",
          ], pri: "P3", cat: "邮箱" },
        r_ticket: { type: "result", level: "ticket", title: "无明显线索，建议转邮件运维",
          text: "网页版与客户端都异常且无退信，需要从邮件网关与日志侧排查。",
          steps: ["请提供：发件时间、收件人、是否收到退信、邮箱配额截图。"],
          pri: "P2", cat: "邮箱", ticketTitle: "邮件收发异常（需检查邮件网关日志）" },
      },
    },

    /* ---------------- 应用系统访问 ---------------- */
    {
      id: "app", name: "业务系统访问诊断", cat: "应用", sla: "P2", icon: "🧩",
      intro: "关键是先判断「影响面」：只影响你、还是影响多人，这直接决定优先级。",
      start: "n1",
      nodes: {
        n1: { type: "choice", q: "是只有这一个系统打不开，还是多个系统都打不开？", options: [
          { label: "只有这一个系统", next: "n_single" },
          { label: "多个系统 / 整个内网都不行", next: "r_network" },
        ] },
        n_single: { type: "choice", q: "问一下旁边同事，他们能正常访问吗？", options: [
          { label: "同事可以正常访问", next: "n_local" },
          { label: "同事也访问不了", next: "r_system" },
        ] },
        n_local: { type: "choice", q: "用浏览器无痕窗口访问，是否正常？", options: [
          { label: "无痕窗口正常", next: "r_cache" },
          { label: "无痕窗口也失败", next: "n_proxy" },
        ] },
        n_proxy: { type: "choice", q: "你近期是否开启过 VPN 或代理软件？", options: [
          { label: "开过", next: "r_proxy" },
          { label: "没开过", next: "n_status" },
        ] },
        n_status: { type: "choice", q: "在状态页 http://status.corp.example.com 是否有该系统的故障公告？", options: [
          { label: "有故障公告", next: "r_known" },
          { label: "没有公告", next: "r_ticket" },
        ] },
        r_network: { type: "result", level: "diag", title: "影响面较大：先按网络故障排查",
          text: "多个系统同时不可用，问题多半在网络层而非单个应用。",
          steps: [
            "切换到「网络连通性诊断」流程定位网络问题；",
            "若多名同事同时受影响，建议直接报障并声明影响范围。",
          ], pri: "P2", cat: "网络", swipe: "net", ticketTitle: "多个业务系统同时无法访问" },
        r_system: { type: "result", level: "ticket", title: "系统侧故障：建议立即转人工",
          text: "多人同时无法访问，属于系统级故障，需要应用运维立即介入。",
          steps: [
            "立即提交工单并勾选「影响多人」，或直接致电服务台声明影响范围；",
            "如涉及生产交易，请说明业务影响（如无法下单），以便判定为 P1；",
            "有条件时先启用线下应急流程，减少业务中断。",
          ], pri: "P1", cat: "应用", ticketTitle: "业务系统多人无法访问（疑似系统故障）" },
        r_cache: { type: "result", level: "self", title: "本机浏览器缓存 / Cookie 异常",
          text: "无痕窗口正常说明是本地缓存或登录态损坏。",
          steps: [
            "清理缓存与 Cookie：Ctrl+Shift+Delete → 选择缓存与 Cookie；",
            "退出该系统的登录后重新登录；",
            "检查是否有插件（广告拦截、脚本管理）影响，逐一禁用排查；",
            "必要时重置浏览器设置。",
          ], pri: "P4", cat: "应用" },
        r_proxy: { type: "result", level: "self", title: "代理 / VPN 导致内网系统不可达",
          text: "代理或 VPN 的路由设置可能把内网请求发往了错误的出口。",
          steps: [
            "完全退出代理软件，或断开 VPN 后直接访问；",
            "关闭系统代理：设置 → 网络和 Internet → 代理 → 关闭手动代理；",
            "若确需 VPN 才能访问，请确认已下发内网路由（见 VPN 诊断流程）。",
          ], pri: "P2", cat: "网络" },
        r_known: { type: "result", level: "diag", title: "已知故障：等待恢复即可",
          text: "状态页已有公告，说明 IT 已介入处理，无需重复提单。",
          steps: [
            "关注状态页与 IT 通知群，按公告的预计恢复时间安排工作；",
            "若已超出公告恢复时间仍未恢复，可致电服务台催促；",
            "如影响关键业务，请联系主管启用应急预案。",
          ], pri: "P3", cat: "应用" },
        r_ticket: { type: "result", level: "ticket", title: "本地排查已穷尽，建议转应用运维",
          text: "同事正常、无痕与代理均已排除，需应用运维从服务端日志定位。",
          steps: ["请提供：系统地址、访问时间、完整报错信息（截图）、账号、本机 IP。"],
          pri: "P2", cat: "应用", ticketTitle: "业务系统无法访问（本地排查已穷尽）" },
      },
    },
  ];

  /* ============================================================
     2. 新员工入职指引（四阶段清单）
     ============================================================ */
  const ONBOARD = {
    title: "新员工 IT 入职指引",
    intro: "按「入职前 → 第 1 天 → 第一周 → 第一个月」四阶段推进，逐项打勾即可完成全部 IT 准备。",
    stages: [
      {
        id: "pre", name: "阶段一 · 入职前（T-3 ~ T-0 天）", owner: "HR / 用人部门 / IT",
        items: [
          { id: "pre1", t: "提交新员工账号开通申请", d: "由用人部门或 HR 在 IT 工单系统提交，注明姓名、工号、部门、岗位与直属主管。", owner: "用人部门", sla: "T-3 天前" },
          { id: "pre2", t: "确认设备准备情况", d: "IT 按岗位标准配置电脑（研发 32G 内存 / 普通岗 16G），并预装标准镜像。", owner: "IT 桌面运维", sla: "T-2 天" },
          { id: "pre3", t: "创建域账号并套用岗位权限模板", d: "普通员工 / 研发 / 管理岗使用不同权限模板，遵循最小权限原则。", owner: "IT 服务台", sla: "T-1 天" },
          { id: "pre4", t: "开通企业邮箱与协作工具", d: "邮箱地址规则：名.姓@corp.example.com；同步开通企业微信账号并加入部门群。", owner: "IT 服务台", sla: "T-1 天" },
          { id: "pre5", t: "准备门禁卡与工位", d: "行政发放门禁卡；IT 确认工位网络端口、显示器与外设可用。", owner: "行政 / IT", sla: "T-1 天" },
        ],
      },
      {
        id: "day1", name: "阶段二 · 入职第 1 天", owner: "新员工 / IT",
        items: [
          { id: "d1", t: "领取设备并现场验机", d: "核对资产编号，当场确认开机、联网、外接显示器与打印功能正常，签署资产领用单。", owner: "新员工 + IT", sla: "当天 9:30-10:00" },
          { id: "d2", t: "首次登录并修改初始密码", d: "初始密码通过短信下发，首次登录强制改密（≥12 位，含大小写、数字、符号）。", owner: "新员工", sla: "当天" },
          { id: "d3", t: "绑定 MFA 双因素认证", d: "按引导绑定认证器 App，并额外绑定备用手机号作为兜底通道。", owner: "新员工", sla: "当天" },
          { id: "d4", t: "激活邮箱与企业微信", d: "登录邮箱确认可正常收发；企业微信加入部门群与相关项目群。", owner: "新员工", sla: "当天" },
          { id: "d5", t: "连接公司 Wi-Fi 与 VPN", d: "连接办公 Wi-Fi（优先 5G 频段）；如需远程办公，提交 VPN 权限申请。", owner: "新员工 / IT", sla: "当天" },
          { id: "d6", t: "完成信息安全意识培训", d: "必修：数据分级、钓鱼邮件识别、U 盘使用规定、数据外发流程。", owner: "信息安全", sla: "第 1 天" },
        ],
      },
      {
        id: "week1", name: "阶段三 · 第一周", owner: "新员工 / 直属主管",
        items: [
          { id: "w1", t: "申请业务系统权限", d: "按岗位职责提交权限申请（如 ERP、CRM、代码仓库、生产只读），经主管与系统负责人审批。", owner: "新员工 + 主管", sla: "3 个工作日内" },
          { id: "w2", t: "访问共享盘并映射网络驱动器", d: "获取部门共享目录权限，映射为网络驱动器便于日常使用。", owner: "IT 服务台", sla: "3 个工作日内" },
          { id: "w3", t: "加入项目邮件组与通知渠道", d: "请主管确认需要订阅的邮件组、企业微信群与值班告警渠道。", owner: "直属主管", sla: "第一周" },
          { id: "w4", t: "熟悉 IT 服务渠道与 SLA", d: "记住：工单系统在线提单、服务台分机 6000、AI 智能助手可自助排查。", owner: "新员工", sla: "第一周" },
          { id: "w5", t: "配置邮箱签名与自动回复", d: "使用公司统一签名模板；休假前设置自动回复并注明紧急联系人。", owner: "新员工", sla: "第一周" },
        ],
      },
      {
        id: "month1", name: "阶段四 · 第一个月", owner: "新员工 / IT",
        items: [
          { id: "m1", t: "权限复核（最小权限校验）", d: "与主管一起复核已开通权限，回收试用期临时权限，避免权限沉淀。", owner: "新员工 + 主管", sla: "第 4 周" },
          { id: "m2", t: "设置网盘与共享盘同步备份", d: "重要工作资料存入部门共享盘或企业网盘，不依赖本机存储。", owner: "新员工", sla: "第 2 周起" },
          { id: "m3", t: "完成安全合规复训", d: "针对岗位数据敏感度，完成进阶安全培训（如涉密岗位的额外要求）。", owner: "信息安全", sla: "第 4 周" },
          { id: "m4", t: "建立个人设备维护习惯", d: "定期清理磁盘、更新补丁与驱动、全盘杀毒；发现异常立即报障。", owner: "新员工", sla: "持续" },
          { id: "m5", t: "反馈入职体验", d: "向 IT 反馈入职过程中的不便之处，用于优化入职流程。", owner: "新员工", sla: "第 4 周" },
        ],
      },
    ],
  };

  /* ============================================================
     3. 插件注册表元信息（用于展示与统计）
     ============================================================ */
  const PLUGIN_META = [
    { id: "faq",     name: "FAQ + 知识库", icon: "📚", desc: "53 条高频问题 + 运维知识库，命中即给答案，支持自助解决" },
    { id: "rag",     name: "语义检索 RAG", icon: "🔎", desc: "从知识库与历史工单中检索并生成带引用的回答" },
    { id: "diag",    name: "故障诊断工作流", icon: "🧭", desc: "7 条决策树流程，逐步定位故障根因" },
    { id: "ticket",  name: "工单系统",      icon: "🎫", desc: "对话中直接建单、查进度，按 SLA 分级响应，紧急问题直达值班电话" },
    { id: "onboard", name: "新员工入职指引", icon: "🎓", desc: "四阶段 21 项清单，进度可保存" },
    { id: "kb",      name: "知识库学习",   icon: "🗂️", desc: "与主系统 KB 双向联动：同步学习新文章，把已验证方案沉淀成文章" },
  ];

  return { FLOWS, ONBOARD, PLUGIN_META };
})();
