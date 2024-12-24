const net = require('net');
const { loadConfig, createLoggers, watchConfig } = require('./config');
const ProxyManager = require('./proxyManager');
const { parseArguments, handleOpenConfig } = require('./cli');
const ProxyServer = require('./proxyServer');
const Dashboard = require('./dashboard');

// 解析命令行参数
const argv = parseArguments();

// 如果指定了打开配置文件选项，则打开配置文件并退出
if (argv['open-config']) {
    handleOpenConfig();
    process.exit(0);
}

class ErrorHandler {
    constructor(logger) {
        this.logger = logger;
    }

    isTerminalError(error) {
        return (
            error.message === 'write EIO' ||
            error.code === 'EIO' ||
            (error.code === 'EPIPE' && error.syscall === 'write') ||
            error.message?.includes('stdout') ||
            error.message?.includes('stderr')
        );
    }

    handleUncaughtException(error, shutdownCallback) {
        if (!this.isTerminalError(error)) {
            this.logger.error({
                event: "未捕获的异常",
                error: error.message,
                stack: error.stack,
            });
            shutdownCallback();
        }
    }

    handleUnhandledRejection(reason, shutdownCallback) {
        this.logger.error({
            event: '未处理的Promise拒绝',
            error: reason
        });
        shutdownCallback();
    }

    handleServerError(err, port) {
        if (err.code === 'EADDRINUSE') {
            this.logger.error({
                event: '服务器错误',
                error: `端口 ${port} 已被占用`
            });
        } else if (err.code === 'EACCES') {
            this.logger.error({
                event: '服务器错误',
                error: `没有权限绑定端口 ${port}，如果端口小于 1024 需要管理员权限`
            });
        } else {
            this.logger.error({
                event: '服务器错误'
            }, err);
        }
        process.exit(1);
    }
}

// 加载配置和创建日志实例
const { config, logger } = loadConfig();

// 使用命令行参数覆盖配置
if (argv.port) {
    config.server.port = argv.port;
}

const { logInfo, logError, logWarn } = createLoggers(logger);

// 创建错误处理器实例
const errorHandler = new ErrorHandler({ error: logError });

// 创建代理管理器实例
const proxyManager = new ProxyManager(config, { info: logInfo, error: logError });

// 创建代理服务器实例
const proxyServer = new ProxyServer(config, {
    proxyManager,
    logInfo,
    logWarn,
    logError
});

// 创建并启动仪表板
const dashboard = new Dashboard(config, proxyServer.resources, {
    logInfo,
    logWarn,
    logError
});
dashboard.start();

// 创建代理服务器
const server = proxyServer.createServer();

// 处理系统代理设置
function setSystemProxy(enable) {
    proxyManager.setSystemProxy(enable);
}

// 优雅退出处理
function gracefulShutdown(restart = false) {
    proxyServer.shutdown();
    dashboard.stop();
    
    logInfo('正在关闭代理服务器...');
    setSystemProxy(false);
    
    proxyServer.closeServer(() => {
        logInfo('服务器已停止接受新连接');
    });
    
    logInfo(`正在关闭 ${proxyServer.connectionsCount} 个活动连接...`);
    
    setTimeout(() => {
        proxyServer.forceShutdown();
        
        if (restart) {
            logInfo('配置已更新，正在重启服务...');
            const scriptPath = require('path').join(__dirname, 'index.js');
            const child = require('child_process').spawn('node', [scriptPath], {
                stdio: 'inherit',
                detached: true
            });
            child.unref();
            logInfo(`子进程与主进程分离，如需关闭进程，请使用以下命令：$ kill ${child.pid}`);
        }
        
        logInfo(restart ? '重启进程中...' : '所有连接已关闭，正在退出程序');
        process.exit(0);
    }, 2000);
}

// 监听配置文件变化
watchConfig(() => {
    logInfo({
        event: '配置文件变更',
        action: '重新加载'
    });
    gracefulShutdown(true);
});

// 设置错误处理
process.on('uncaughtException', (error) => {
    errorHandler.handleUncaughtException(error, () => gracefulShutdown());
});

process.on('unhandledRejection', (reason, promise) => {
    errorHandler.handleUnhandledRejection(reason, () => gracefulShutdown());
});

// 监听终止信号
process.on('SIGINT', () => gracefulShutdown());   // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown());  // kill
process.on('SIGHUP', () => gracefulShutdown());   // 终端关闭

// 启动服务器
const { host, port, backlog } = config.server;

// 验证端口范围
if (port < 1 || port > 65535) {
    logError({
        event: '配置错误',
        error: `端口号 ${port} 无效，必须在 1-65535 之间`
    });
    process.exit(1);
}

// 启动服务器并处理可能的错误
server.listen(port, host, backlog, () => {
    const address = server.address();
    logInfo({
        event: '服务器启动',
        address: address.address,
        port: address.port,
        family: address.family
    });

    setSystemProxy(true);
});

server.on('error', (err) => errorHandler.handleServerError(err, port));
