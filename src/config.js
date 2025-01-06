const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const winston = require('winston');
const os = require('os');

// 配置文件查找顺序
const CONFIG_PATHS = [
    path.join(process.cwd(), 'config.yml'),           // 当前工作目录
    path.join(os.homedir(), '.app-proxy/config.yml'), // 用户主目录下的 .app-proxy 文件夹
    path.join(__dirname, '../config.yml')             // 项目安装目录
];


// 解析文件大小配置（如：10m, 1g）
function parseFileSize(size) {
    const units = {
        'k': 1024,
        'm': 1024 * 1024,
        'g': 1024 * 1024 * 1024
    };
    
    const match = size.toString().match(/^(\d+)([kmg])$/i);
    if (match) {
        const [, number, unit] = match;
        return parseInt(number) * units[unit.toLowerCase()];
    }
    return parseInt(size);
}

// 创建日志实例
function createLogger(config) {
    const transports = [];
    let logFileDir;
    // 确保日志目录存在
    if (config.logging.file.error_log.enabled || 
        config.logging.file.warning_log.enabled || 
        config.logging.file.combined_log.enabled) {
        logFileDir = configFilePath && path.dirname(configFilePath) 
            ? path.join(path.dirname(configFilePath), config.logging.file.directory) 
            : config.logging.file.directory;
        
        if (!fs.existsSync(logFileDir)) {
            fs.mkdirSync(logFileDir, { recursive: true });
        }
    }

    // 添加控制台日志
    if (config.logging.console.enabled) {
        transports.push(new winston.transports.Console({
            level: config.logging.console.level,
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp(),
                winston.format.printf((info) => {
                    const { level, timestamp, message, ...rest } = info;
                    let logMessage = `${timestamp} ${level}: `;

                    // 如果message是对象，将其合并到rest中
                    if (typeof message === 'object' && message !== null) {
                        Object.assign(rest, message);
                    } else if (typeof message === 'string') {
                        logMessage += message;
                    }

                    // 处理rest中的字段
                    if (Object.keys(rest).length > 0) {
                        if (rest.event) logMessage += `[${rest.event}] `;
                        if (rest.app) logMessage += `应用=${rest.app} `;
                        if (rest.target) logMessage += `目标=${rest.target} `;
                        if (rest.proxy) logMessage += `代理=${rest.proxy} `;
                        if (rest.mode) logMessage += `模式=${rest.mode} `;
                        if (rest.error) logMessage += `错误=${rest.error} `;
                        if (rest.rule) logMessage += `规则=${rest.rule} `;

                        // 添加其他字段
                        Object.entries(rest).forEach(([key, value]) => {
                            if (value !== undefined && 
                                !['event', 'app', 'target', 'proxy', 'mode', 'error', 'rule', 'stack', 'level', 'timestamp'].includes(key)) {
                                logMessage += `${key}=${value} `;
                            }
                        });
                    }

                    return logMessage.trim() || `${timestamp} ${level}: <空日志>`;
                })
            )
        }));
    }

    // 添加错误日志
    if (config.logging.file.error_log.enabled) {
        transports.push(new winston.transports.File({
            filename: path.join(logFileDir, config.logging.file.error_log.filename),
            level: config.logging.file.error_log.level,
            maxsize: parseFileSize(config.logging.file.max_size),
            maxFiles: config.logging.file.max_files,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }));
    }
    // 警告日志配置
    if (config.logging.file.warning_log.enabled) {
        transports.push(new winston.transports.File({
            filename: path.join(logFileDir, config.logging.file.warning_log.filename),
            level: config.logging.file.warning_log.level,
            maxsize: parseFileSize(config.logging.file.max_size),
            maxFiles: config.logging.file.max_files,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }));
    }

    // 添加综合日志
    if (config.logging.file.combined_log.enabled) {
        transports.push(new winston.transports.File({
            filename: path.join(logFileDir, config.logging.file.combined_log.filename),
            level: config.logging.file.combined_log.level,
            maxsize: parseFileSize(config.logging.file.max_size),
            maxFiles: config.logging.file.max_files,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }));
    }

    return winston.createLogger({
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        ),
        transports: transports
    });
}

let configFilePath;
// 修改加载配置函数
function loadConfig() {
    let configFileData;
    // 按优先级查找配置文件
    for (const path of CONFIG_PATHS) {
        if (fs.existsSync(path)) {
            configFileData = fs.readFileSync(path, 'utf8');
            configFilePath = path;
            break;
        }
    }

    // 如果没有找到配置文件，创建默认配置
    if (!configFileData) {
        const defaultConfigDir = path.join(os.homedir(), '.app-proxy');
        const defaultConfigPath = path.join(defaultConfigDir, 'config.yml');
        
        // 创建配置目录
        if (!fs.existsSync(defaultConfigDir)) {
            fs.mkdirSync(defaultConfigDir, { recursive: true });
        }

        // 创建默认配置文件
        const defaultConfig = `
# 服务器配置
server:
  host: "127.0.0.1"    # 监听所有网卡
  port: 8080         # 监听端口
  backlog: 1024      # TCP 连接队列大小
  excluded_services: # 不设置代理的网络服务
    - "Thunderbolt Bridge"
    - "Thunderbolt Bridge status"

# 代理域名映射配置
proxy_domain_map:
  "10.20.30.1:8888":
    - "*.google.com"

# 代理应用程序映射配置
proxy_app_map:
  "10.20.30.1:8888":
    - "code helper (plugin)"
    - "com.docker.backend"

  "127.0.0.1:8081":
    - "firefox"

# 日志配置
logging:
  console:
    enabled: true
    level: info
  file:
    error_log:
      enabled: true
      level: error
      filename: error.log
    warning_log: 
      enabled: false
      level: warn
      filename: warning.log
    combined_log:
      enabled: false
      level: info
      filename: combined.log
    directory: logs
    max_size: 10m
    max_files: 5

# Dashboard配置
dashboard:
  enabled: true
  port: 8081
  host: "127.0.0.1"
`;

        fs.writeFileSync(defaultConfigPath, defaultConfig);
        configFileData = defaultConfig;
        configFilePath = defaultConfigPath;
    }

    try {
        const config = yaml.parse(configFileData);
        const logger = createLogger(config);
        
        // 记录使用的配置文件路径
        logger.info({
            event: '配置加载',
            path: configFilePath
        });
        
        return { config, logger,configFilePath};
    } catch (error) {
        console.error('配置文件解析失败:', error);
        process.exit(1);
    }
}
// 封装日志函数
function createLoggers(logger) {
    return {
        logInfo: (data) => {
            if (typeof data === 'string') {
                logger.info(data);
            } else {
                logger.info({ ...data });
            }
        },
        logWarn: (data, warning) => {  // 新增警告日志方法
            if (warning) {
                logger.warn({
                    ...data,
                    warning: warning.message,
                    code: warning.code,
                    syscall: warning.syscall,
                    address: warning.address,
                    port: warning.port
                });
            } else {
                logger.warn(data);
            }
        },
        logError: (data, error) => {
            if (error) {
                logger.error({
                    ...data,
                    error: error.message,
                    stack: error.stack,
                    code: error.code,
                    errno: error.errno,
                    syscall: error.syscall,
                    address: error.address,
                    port: error.port
                });
            } else {
                logger.error(data);
            }
        }
    };
}

// 监听配置文件变化
function watchConfig(callback) {
    fs.watch(configFilePath, (eventType) => {
        if (eventType === 'change') {
            callback();
        }
    });
}

module.exports = {
    loadConfig,
    createLoggers,
    watchConfig
};

