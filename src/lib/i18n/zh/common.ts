// 通用：确认框、窗口、错误提示、网络、模型、环境、项目、模式、账号、欢迎页、Markdown、导出（中文）

export default {
  // Common
  'common.cancel': '取消',
  'common.confirm': '确认',
  'confirm.exit': '确定要退出 ClaudeDeck 吗？正在运行的任务将被终止。',
  'confirm.exitRunning': '有 {n} 个任务正在运行（{detail}）。退出将中断这些任务，确定要退出 ClaudeDeck 吗？',
  'confirm.exitLocal': '本地 {n} 个',
  'confirm.exitRemote': '远程 {host} {n} 个',
  'model.cliDefault': 'CLI 默认',
  'md.footnotes': '脚注',
  'md.footnoteBack': '返回正文',
  'md.fileNotInProject': '只有文件名，无法确定位置，不能直接打开',
  'md.openDirectory': '点击在资源管理器中打开',
  'window.minimize': '最小化',
  'window.maximize': '最大化',
  'window.restore': '向下还原',
  'window.close': '关闭',

  // 导出会话（/export 命令、会话右键菜单）
  'export.success': '已导出到',

  // ProjectSelector
  'project.selectFolder': '选择项目文件夹',
  'project.selectBtn': '选择项目...',
  'project.directoryMissing': '项目文件夹已被移动或删除，请重新选择',
  'project.recheck': '重新检查',
  'project.reselect': '重新选择',

  // Error classification
  'error.technicalSummary': '遇到了一个技术问题，通常重试即可解决。',
  'error.showDetails': '查看详情',
  'error.invalidKey': '🔑 API 密钥无效或已过期，请检查设置中的 API Key 是否正确。',
  'error.rateLimit': '⏳ 请求太频繁，请稍等几秒后重试。',
  'error.quotaExceeded': '💰 API 余额不足，请充值后重试。',
  'error.modelNotFound': '🤖 模型不存在或不可用，请在设置中切换其他模型。',
  'error.networkError': '🌐 网络连接失败，请检查网络设置或稍后重试。',
  'error.permissionDenied': '🚫 操作被拒绝，请检查权限设置。',
  'error.serviceUnavailable': '🔧 服务暂时繁忙，请稍后重试。',
  'error.cliNotInstalled': '⚙️ CLI 未正确安装，请在设置中重新安装。',
  'error.tokenLimit': '📏 对话太长了，请新建一个任务继续。',
  'error.genericFallback': '出了点问题，请稍后重试。',
  'error.cliExitedSilently': 'CLI 意外退出且无输出，请检查 CLI 是否已正确安装（设置 → CLI），以及 API 服务商是否已配置。',

  // ModeSelector
  'mode.code': '标准自动',
  'mode.ask': '询问',
  'mode.plan': '计划',
  'mode.auto': '智能自动',
  'mode.bypass': '全自动',

  // WelcomeScreen
  'welcome.newChat': '选择文件夹',
  'welcome.subtitle': '选择一个项目文件夹以开始',
  'welcome.recentProjects': '最近项目',
  'env.local': '本地模式',
  'env.remoteMode': '远程模式',
  'env.open': '打开',
  'env.remoteWelcome': '输入远端项目目录，在该电脑上开始对话',
  'account.loggedIn': '已登录',
  'account.loggedOut': '未登录',
  'account.login': '登录',
  'account.switch': '切换账号',
  'account.refresh': '重新检查登录状态',
  'account.provider': '当前服务商：{name}',

  // Network / firewall hints
  'network.firewallHint': '网络连接失败，可能需要 VPN 或代理才能访问',
  'error.permissionHint': '权限不足，请以管理员身份运行，或检查防病毒软件是否锁定了相关目录',
};
