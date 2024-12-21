const yargs = require('yargs');

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
    .help()
    .argv;
}

module.exports = { parseArguments };