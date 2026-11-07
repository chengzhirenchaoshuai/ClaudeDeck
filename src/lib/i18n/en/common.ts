// 通用：确认框、窗口、错误提示、网络、模型、环境、项目、模式、账号、欢迎页、Markdown、导出（英文）
import type zh from '../zh/common';

export default {
  // Common
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'confirm.exit': 'Are you sure you want to quit ClaudeDeck? Running tasks will be terminated.',
  'confirm.exitRunning': '{n} task(s) are running ({detail}). Quitting will interrupt them. Quit ClaudeDeck?',
  'confirm.exitLocal': '{n} local',
  'confirm.exitRemote': '{n} on {host}',
  'model.cliDefault': 'CLI default',
  'md.footnotes': 'Footnotes',
  'md.footnoteBack': 'Back to content',
  'md.fileNotInProject': 'Only a file name was given, so it can\'t be located and opened',
  'md.openDirectory': 'Click to open in Explorer',
  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.restore': 'Restore Down',
  'window.close': 'Close',

  // 导出会话（/export 命令、会话右键菜单）
  'export.success': 'Exported to',

  // ProjectSelector
  'project.selectFolder': 'Select Project Folder',
  'project.selectBtn': 'Select project...',
  'project.directoryMissing': 'Project folder has been moved or deleted. Please select a new one.',
  'project.recheck': 'Check again',
  'project.reselect': 'Reselect',

  // Error classification
  'error.technicalSummary': 'A technical issue occurred. Retrying usually resolves it.',
  'error.showDetails': 'Show details',
  'error.invalidKey': '🔑 API key is invalid or expired. Please check the API Key in settings.',
  'error.rateLimit': '⏳ Too many requests. Please wait a few seconds and try again.',
  'error.quotaExceeded': '💰 API balance is insufficient. Please top up and try again.',
  'error.modelNotFound': '🤖 Model not found or unavailable. Please switch to another model in settings.',
  'error.networkError': '🌐 Network connection failed. Please check your network settings or try again later.',
  'error.permissionDenied': '🚫 Operation was denied. Please check your permissions.',
  'error.serviceUnavailable': '🔧 Service is temporarily busy. Please try again later.',
  'error.cliNotInstalled': '⚙️ CLI is not properly installed. Please reinstall in settings.',
  'error.tokenLimit': '📏 Conversation is too long. Please start a new task to continue.',
  'error.genericFallback': 'Something went wrong. Please try again later.',
  'error.cliExitedSilently': 'CLI process exited unexpectedly without output. Please check that Claude CLI is installed correctly (Settings → CLI) and that your API provider is configured.',

  // ModeSelector
  'mode.code': 'Auto',
  'mode.ask': 'Ask',
  'mode.plan': 'Plan',
  'mode.auto': 'Smart Auto',
  'mode.bypass': 'Full Auto',

  // WelcomeScreen
  'welcome.newChat': 'Select Folder',
  'welcome.subtitle': 'Select a project folder to get started',
  'welcome.recentProjects': 'Recent Projects',
  'env.local': 'Local mode',
  'env.remoteMode': 'Remote mode',
  'env.open': 'Open',
  'env.remoteWelcome': 'Enter a folder on the remote PC to start a conversation there',
  'account.loggedIn': 'Signed in',
  'account.loggedOut': 'Not signed in',
  'account.login': 'Sign in',
  'account.switch': 'Switch account',
  'account.refresh': 'Check sign-in status again',
  'account.provider': 'Current provider: {name}',

  // Network / firewall hints
  'network.firewallHint': 'Network error — you may need a VPN or proxy to connect',
  'error.permissionHint': 'Permission denied — try running as administrator, or check if antivirus is blocking the directory',
} satisfies Record<keyof typeof zh, string>;
