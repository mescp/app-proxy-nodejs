const yargs = require('yargs');
const { loadConfig } = require('./config');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

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
    .option('daemon', {
      alias: 'd',
      describe: '以守护进程方式在后台运行',
      type: 'boolean',
      default: false
    })
    .option('stop', {
      alias: 's',
      describe: '停止当前运行的程序',
      type: 'boolean',
      default: false
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

function startDaemon() {
  const args = process.argv.slice(2).filter(arg => arg !== '-d' && arg !== '--daemon');
  
  const child = spawn(process.argv[0], [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });

  child.unref();
  console.log('程序已在后台启动，进程 ID:', child.pid);
  process.exit(0);
}

function findProcessId() {
  try {
    // 使用 pgrep 命令查找进程
    const output = execSync('pgrep -f app-proxy').toString();
    const pids = output.split('\n').filter(Boolean);
    
    // 返回第一个找到的进程ID
    if (pids.length > 0) {
      return pids[0];
    }
  } catch (error) {
    // pgrep 没有找到进程时会返回错误，这是正常的
    return null;
  }
  return null;
}

function stopProcess() {
  const pid = findProcessId();
  if (!pid) {
    console.log('没有找到正在运行的程序');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log('已发送停止信号到进程:', pid);
    
    // 等待进程结束
    let attempts = 0;
    const maxAttempts = 10;
    const checkInterval = setInterval(() => {
      try {
        process.kill(pid, 0);
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          console.log('程序可能未正常退出，请尝试使用强制终止：kill -9', pid);
        }
      } catch (e) {
        clearInterval(checkInterval);
        console.log('程序已成功停止');
      }
    }, 500);
  } catch (error) {
    console.error('停止程序时出错:', error.message);
  }
}

module.exports = { parseArguments, handleOpenConfig, startDaemon, stopProcess };