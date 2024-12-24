const yargs = require('yargs');
const { loadConfig } = require('./config');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
function openFile(filePath) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open "${filePath}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${filePath}"`);
    } else {
      execSync(`xdg-open "${filePath}"`);
    }
  } catch (error) {
    console.error('打开文件失败:', error.message);
  }
}

function parseArguments() {
  return yargs
    .option('config', {
      alias: 'c',
      describe: '配置文件路径',
      type: 'string',
      default: 'config.yml'
    })
    .option('port', {
      alias: 'p',
      describe: '代理服务器端口',
      type: 'number'
    })
    .option('open-config', {
      alias: 'o',
      describe: '打开当前配置文件',
      type: 'boolean'
    })
    .help()
    .argv;
}

function handleOpenConfig() {
  const { configFilePath } = loadConfig();
  if (configFilePath && fs.existsSync(configFilePath)) {
      openFile(configFilePath);
      console.log(`已打开配置文件: ${configFilePath}`);
    } else {
      console.error('无法找到配置文件路径');
    }
    process.exit(0);
}

module.exports = { parseArguments, handleOpenConfig };