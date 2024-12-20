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
    return config.default_proxy;
}

// 创建代理服务器
const server = net.createServer((clientSocket) => {
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
        const targetProxy = appName ? getProxyByApp(appName) : config.default_proxy;

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
        });

        proxySocket.on('error', (err) => {
            logger.error('Proxy connection error:', err);
            clientSocket.destroy();
        });
    });

    clientSocket.on('error', (err) => {
        logger.error('Client connection error:', err);
    });
});

// 启动服务器
const PORT = 8080;
server.listen(PORT, () => {
    logger.info(`Proxy server listening on port ${PORT}`);
});

// 优雅退出
process.on('SIGINT', () => {
    logger.info('Shutting down proxy server...');
    appCache.close();
    server.close(() => {
        logger.info('Server shut down complete');
        process.exit(0);
    });
});
