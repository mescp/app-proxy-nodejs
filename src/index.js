const net = require('net');
const { execSync } = require('child_process');
const NodeCache = require('node-cache');
const { loadConfig, createLoggers, watchConfig, CONFIG_PATH } = require('./config');

// 加载配置和创建日志实例
const { config, logger } = loadConfig();
const { logInfo, logError } = createLoggers(logger);

// 创建缓存实例
const appCache = new NodeCache({ stdTTL: 300 }); // 5分钟缓存

// 系统代理管理函数
function getNetworkServices() {
    try {
        const output = execSync('networksetup -listallnetworkservices').toString();
        // 过滤掉第一行（标题）、带星号的禁用服务和排除列表中的服务
        const excludedServices = new Set(config.server.excluded_services || []);
        return output.split('\n')
            .slice(1)
            .filter(service => 
                service && 
                !service.startsWith('*') && 
                !excludedServices.has(service.trim())
            );
    } catch (error) {
        logError({
            event: '获取网络服务列表失败',
            error: error.message
        });
        return [];
    }
}

function setSystemProxy(enable) {
    const services = getNetworkServices();
    const proxyHost = '127.0.0.1'; // 本地代理
    
    if (services.length === 0) {
        logInfo({
            event: '系统代理设置',
            status: '没有可用的网络服务'
        });
        return;
    }
    
    for (const service of services) {
        try {
            if (enable) {
                // 设置 HTTP 代理
                execSync(`networksetup -setwebproxy "${service}" ${proxyHost} ${config.server.port}`);
                execSync(`networksetup -setwebproxystate "${service}" on`);
                
                // 设置 HTTPS 代理
                execSync(`networksetup -setsecurewebproxy "${service}" ${proxyHost} ${config.server.port}`);
                execSync(`networksetup -setsecurewebproxystate "${service}" on`);
                
                logInfo({
                    event: '系统代理设置',
                    service: service,
                    status: '已启用',
                    proxy: `${proxyHost}:${config.server.port}`
                });
            } else {
                // 关闭 HTTP 代理
                execSync(`networksetup -setwebproxystate "${service}" off`);
                // 关闭 HTTPS 代理
                execSync(`networksetup -setsecurewebproxystate "${service}" off`);
                
                logInfo({
                    event: '系统代理设置',
                    service: service,
                    status: '已禁用'
                });
            }
        } catch (error) {
            logError({
                event: '系统代理设置失败',
                service: service,
                error: error.message
            });
        }
    }
}

// 获取应用程序名称（仅支持macOS）
function getAppNameByPort(port) {
    try {
        const cmd = `lsof -n -P -sTCP:ESTABLISHED +c0 -i :${port}`;
        const output = execSync(cmd).toString();
        const lines = output.split('\n');
        const clientLine = lines.find(line => line.includes(`${port}->`));
        if (clientLine) {
            const appName = clientLine.split(/\s+/)[0].toLowerCase();
            return appName.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
            });
        }
        return null;
    } catch (error) {
        logError('Error getting app name:', error);
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

// 标记服务器状态
let isShuttingDown = false;

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
            // 解析原始请求数据以获取目标地址和端口
            const firstLine = data.toString().split('\n')[0];
            const match = firstLine.match(/^(?:CONNECT\s+)?(\S+):(\d+)/i);
            if (match) {
                const [, host, port] = match;
                logInfo({
                    event: '透明代理模式',
                    app: appName || '未知应用',
                    target: `${host}:${port}`,
                    mode: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
                });

                const directSocket = new net.Socket();
                directSocket.connect(parseInt(port), host, () => {
                    logInfo({
                        event: '直连成功',
                        app: appName || '未知应用',
                        target: `${host}:${port}`,
                        mode: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
                    });

                    if (firstLine.startsWith('CONNECT')) {
                        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    } else {
                        directSocket.write(data);
                    }
                    clientSocket.pipe(directSocket);
                    directSocket.pipe(clientSocket);
                    
                    activeConnections.add(directSocket);
                    
                    directSocket.on('close', () => {
                        logInfo({
                            event: '直连关闭',
                            app: appName || '未知应用',
                            target: `${host}:${port}`
                        });
                        activeConnections.delete(directSocket);
                    });
                });
                directSocket.on('error', (err) => {
                    logError({
                        event: '直连错误',
                        app: appName || '未知应用',
                        target: `${host}:${port}`
                    }, err);
                    activeConnections.delete(directSocket);
                    clientSocket.destroy();
                });
            } else {
                logError({
                    event: '解析失败',
                    app: appName || '未知应用',
                    data: firstLine
                });
                clientSocket.destroy();
            }
            return;
        }

        // 创建到目标代理的连接
        const proxySocket = new net.Socket();
        
        logInfo({
            event: '代理模式',
            app: appName || '未知应用',
            proxy: `${targetProxy.host}:${targetProxy.port}`
        });

        proxySocket.connect(targetProxy.port, targetProxy.host, () => {
            logInfo({
                event: '代理连接成功',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            });

            proxySocket.write(data);
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
            
            activeConnections.add(proxySocket);
            
            proxySocket.on('close', () => {
                logInfo({
                    event: '代理连接关闭',
                    app: appName || '未知应用',
                    proxy: `${targetProxy.host}:${targetProxy.port}`
                });
                activeConnections.delete(proxySocket);
            });
        });

        proxySocket.on('error', (err) => {
            logError({
                event: '代理连接错误',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            }, err);
            activeConnections.delete(proxySocket);
            clientSocket.destroy();
        });
    });

    clientSocket.on('close', () => {
        activeConnections.delete(clientSocket);
    });

    clientSocket.on('error', (err) => {
        logError({
            event: '客户端连接错误'
        }, err);
        activeConnections.delete(clientSocket);
    });
});

// 监听配置文件变化
watchConfig(() => {
    logInfo({
        event: '配置文件变更',
        action: '重新加载'
    });
    gracefulShutdown(true);
});

// 优雅退出处理
function gracefulShutdown(restart = false) {
    // 防止重复调用
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    logInfo('正在关闭代理服务器...');
    
    // 关闭系统代理
    setSystemProxy(false);
    
    // 停止接受新的连接
    server.close(() => {
        logInfo('服务器已停止接受新连接');
    });
    
    // 关闭所有活动连接
    logInfo(`正在关闭 ${activeConnections.size} 个活动连接...`);
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
        
        if (restart) {
            logInfo('配置已更新，正在重启服务...');
            // 使用 node 重启当前进程
            const scriptPath = path.join(__dirname, 'index.js');
            execSync(`node "${scriptPath}"`, {
                stdio: 'inherit',
                detached: true
            });
        }
        
        logInfo(restart ? '重启进程中...' : '所有连接已关闭，正在退出程序');
        process.exit(0);
    }, 2000); // 等待2秒后强制关闭
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    logError({
        event: '未捕获的异常',
        error: error.message,
        stack: error.stack
    });
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logError({
        event: '未处理的Promise拒绝',
        error: reason
    });
    gracefulShutdown();
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

    // 设置系统代理
    setSystemProxy(true);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logError({
            event: '服务器错误',
            error: `端口 ${port} 已被占用`
        });
    } else if (err.code === 'EACCES') {
        logError({
            event: '服务器错误',
            error: `没有权限绑定端口 ${port}，如果端口小于 1024 需要管理员权限`
        });
    } else {
        logError({
            event: '服务器错误'
        }, err);
    }
    process.exit(1);
});
