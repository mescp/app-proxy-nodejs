const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const winston = require('winston');

// 配置文件路径
const CONFIG_PATH = path.join(process.cwd(), 'config.yml');

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

    // 确保日志目录存在
    if (config.logging.file.error_log.enabled || config.logging.file.combined_log.enabled) {
        const logDir = config.logging.file.directory;
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
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
            filename: path.join(config.logging.file.directory, config.logging.file.error_log.filename),
            level: config.logging.file.error_log.level,
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
            filename: path.join(config.logging.file.directory, config.logging.file.combined_log.filename),
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

// 加载配置
function loadConfig() {
    try {
        const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const logger = createLogger(config);
        return { config, logger };
    } catch (error) {
        console.error('加载配置文件失败:', error);
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
    fs.watch(CONFIG_PATH, (eventType) => {
        if (eventType === 'change') {
            callback();
        }
    });
}

module.exports = {
    CONFIG_PATH,
    loadConfig,
    createLoggers,
    watchConfig
};
