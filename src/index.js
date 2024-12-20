const net = require('net');
const fs = require('fs');
const yaml = require('yaml');
const winston = require('winston');
const NodeCache = require('node-cache');
const { execSync } = require('child_process');

// 配置日志
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

// 创建缓存实例
const appCache = new NodeCache({ stdTTL: 300 }); // 5分钟缓存

// 加载配置
const config = yaml.parse(fs.readFileSync('./config.yml', 'utf8'));

// 获取应用程序名称（仅支持macOS）
function getAppNameByPort(port) {
    try {
        const cmd = `lsof -n -P -sTCP:ESTABLISHED +c0 -i :${port}`;
        const output = execSync(cmd).toString();
        const lines = output.split('\n');
        const clientLine = lines.find(line => line.includes(`${port}`));
        if (clientLine) {
            return clientLine.split(/\s+/)[0].toLocaleLowerCase();
        }
        return null;
    } catch (error) {
        logger.error('Error getting app name:', error);
        return null;
    }
}

// 根据应用名称获取代理
function getProxyByApp(appName) {
    for (const [proxyAddr, apps] of Object.entries(config.proxy_app_map)) {
        if (apps.some(app => appName.includes(app.toLowerCase()))) {
            const [host, port] = proxyAddr.split(':');
            return { host, port: parseInt(port) };
        }
    }
    return null;  // 如果没有匹配的代理配置，返回 null
}

// 跟踪所有活动的连接
const activeConnections = new Set();

// 创建代理服务器
const server = net.createServer((clientSocket) => {
    // 添加到活动连接集合
    activeConnections.add(clientSocket);
    
    clientSocket.once('data', (data) => {
        // 获取客户端端口
        const clientPort = clientSocket.remotePort;
        
        // 从缓存获取应用名称或重新获取
        let appName = appCache.get(clientPort);
        if (!appName) {
            appName = getAppNameByPort(clientPort);
            if (appName) {
                appCache.set(clientPort, appName);
            }
        }

        // 获取目标代理
        const targetProxy = appName ? getProxyByApp(appName) : null;

        if (!targetProxy) {
            logger.info({
                message: '没有配置代理，切换为透明代理模式',
                app: appName
            });
            // 解析原始请求数据以获取目标地址和端口
            const firstLine = data.toString().split('\n')[0];
            const match = firstLine.match(/^(?:CONNECT\s+)?(\S+):(\d+)/i);
            if (match) {
                const [, host, port] = match;
                const directSocket = new net.Socket();
                directSocket.connect(parseInt(port), host, () => {
                    logger.info({
                        message: '直接连接目标地址成功',
                        target: `${host}:${port}`
                    });
                    if (firstLine.startsWith('CONNECT')) {
                        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    } else {
                        directSocket.write(data);
                    }
                    clientSocket.pipe(directSocket);
                    directSocket.pipe(clientSocket);
                    
                    // 添加直接连接到活动连接集合
                    activeConnections.add(directSocket);
                    
                    // 当连接关闭时从集合中移除
                    directSocket.on('close', () => {
                        activeConnections.delete(directSocket);
                    });
                });
                directSocket.on('error', (err) => {
                    logger.error('直接连接错误:', err);
                    activeConnections.delete(directSocket);
                    clientSocket.destroy();
                });
            } else {
                logger.error('无法解析目标地址');
                clientSocket.destroy();
            }
            return;
        }

        // 创建到目标代理的连接
        const proxySocket = new net.Socket();
        
        proxySocket.connect(targetProxy.port, targetProxy.host, () => {
            logger.info({
                message: 'Proxy connection established',
                app: appName,
                target: `${targetProxy.host}:${targetProxy.port}`
            });

            proxySocket.write(data);
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
            
            // 添加代理连接到活动连接集合
            activeConnections.add(proxySocket);
            
            // 当连接关闭时从集合中移除
            proxySocket.on('close', () => {
                activeConnections.delete(proxySocket);
            });
        });

        proxySocket.on('error', (err) => {
            logger.error('Proxy connection error:', err);
            activeConnections.delete(proxySocket);
            clientSocket.destroy();
        });
    });

    // 当客户端连接关闭时从集合中移除
    clientSocket.on('close', () => {
        activeConnections.delete(clientSocket);
    });

    clientSocket.on('error', (err) => {
        logger.error('Client connection error:', err);
        activeConnections.delete(clientSocket);
    });
});

// 优雅退出处理
function gracefulShutdown() {
    logger.info('正在关闭代理服务器...');
    
    // 停止接受新的连接
    server.close(() => {
        logger.info('服务器已停止接受新连接');
    });
    
    // 关闭所有活动连接
    logger.info(`正在关闭 ${activeConnections.size} 个活动连接...`);
    for (const socket of activeConnections) {
        socket.end();
    }
    
    // 给连接一些时间优雅关闭
    setTimeout(() => {
        // 强制关闭任何仍然存在的连接
        for (const socket of activeConnections) {
            socket.destroy();
        }
        
        // 清理其他资源
        appCache.close();
        logger.info('所有连接已关闭，正在退出程序');
        process.exit(0);
    }, 2000); // 等待2秒后强制关闭
}

// 监听终止信号
process.on('SIGINT', gracefulShutdown);  // Ctrl+C
process.on('SIGTERM', gracefulShutdown); // kill
process.on('SIGHUP', gracefulShutdown);  // 终端关闭

// 启动服务器
const PORT = 8080;
server.listen(PORT, () => {
    logger.info(`Proxy server listening on port ${PORT}`);
});
