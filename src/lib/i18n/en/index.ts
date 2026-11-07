// 英文词条：按领域分文件，这里合并成一张表
import common from './common';
import chat from './chat';
import commands from './commands';
import sidebar from './sidebar';
import files from './files';
import settings from './settings';
import setup from './setup';

export default {
  ...common,
  ...chat,
  ...commands,
  ...sidebar,
  ...files,
  ...settings,
  ...setup,
};
