const net = require('net');
const NodeCache = require('node-cache');

class ResourceManager {
    constructor() {
        this.activeConnections = new Set();
        this.portConnections = new Map();
        this.isShuttingDown = false;
        // 用于缓存端口号与应用程序名称的映射关系，避免频繁执行lsof命令
        this.appCache = new NodeCache({ 
            stdTTL: 0,        // 永不过期
            checkperiod: 0,   // 不检查过期项
            useClones: false  // 不克隆值以提高性能
        });
        // 用于缓存应用程序与其访问的远端目标的映射关系
        this.appTargetCache = new NodeCache({
            stdTTL: 300,      // 5分钟后过期
            checkperiod: 60,  // 每分钟检查过期项
            useClones: false  // 不克隆值以提高性能
        });
    }

    addConnection(socket) {
        this.activeConnections.add(socket);
        
        const port = socket.remotePort;
        if (port) {
            if (!this.portConnections.has(port)) {
                this.portConnections.set(port, new Set());
            }
            this.portConnections.get(port).add(socket);
        }
    }

    removeConnection(socket) {
        this.activeConnections.delete(socket);
        
        const port = socket.remotePort;
        if (port && this.portConnections.has(port)) {
            const connections = this.portConnections.get(port);
            connections.delete(socket);
            
            if (connections.size === 0) {
                this.portConnections.delete(port);
                this.appCache.del(port);
            }
        }
    }

    hasActiveConnections(port) {
        return this.portConnections.has(port) && this.portConnections.get(port).size > 0;
    }

    getCachedAppName(port) {
        if (this.hasActiveConnections(port)) {
            return this.appCache.get(port);
        }
        return null;
    }

    setCachedAppName(port, appName) {
        if (this.hasActiveConnections(port)) {
            this.appCache.set(port, appName);
        }
    }

    closeConnections() {
        for (const socket of this.activeConnections) {
            socket.end();
        }
    }

    forceCloseConnections() {
        for (const socket of this.activeConnections) {
            socket.destroy();
        }
    }

    cleanup() {
        this.portConnections.clear();
        this.appCache.close();
        this.appTargetCache.close();
    }

    get connectionsCount() {
        return this.activeConnections.size;
    }

    // 获取指定端口的连接统计信息
    getConnectionStats(port) {
        if (!this.portConnections.has(port)) {
            return null;
        }

        const connections = this.portConnections.get(port);
        const total = connections.size;
        const idle = 0; // 目前没有实现空闲连接的统计，默认为0
        const avgIdleTime = 0; // 目前没有实现空闲时间的统计，默认为0

        return {
            total,
            idle,
            avgIdleTime
        };
    }

    // 记录应用访问的远端目标
    recordAppTarget(appName, target) {
        if (!appName || !target) return;
        
        let targets = this.appTargetCache.get(appName) || new Set();
        targets.add(JSON.stringify(target)); // 将目标对象转换为字符串以便于Set去重
        this.appTargetCache.set(appName, targets);
    }

    // 获取应用访问的所有远端目标
    getAppTargets(appName) {
        if (!appName) return [];
        const targets = this.appTargetCache.get(appName);
        if (!targets) return [];
        return Array.from(targets).map(t => JSON.parse(t)).reverse();
    }

    // 获取所有应用的目标映射
    getAllAppTargets() {
        const result = new Map();
        const apps = this.appCache.keys();
        
        for (const appName of apps) {
            const targets = this.getAppTargets(appName);
            if (targets.length > 0) {
                result.set(appName, targets);
            }
        }
        
        return result;
    }
}

class ProxyServer {
    constructor(config, { proxyManager, logInfo, logWarn, logError }) {
        this.config = config;
        this.proxyManager = proxyManager;
        this.logInfo = logInfo;
        this.logWarn = logWarn;
        this.logError = logError;
        this.server = null;
        this.resources = new ResourceManager();
    }

    // 获取应用名称（仅支持macOS）
    getAppNameByPort(port) {
        return this.proxyManager.getAppNameByPort(port);
    }

    // 根据应用名称获取代理
    getProxyByApp(appName) {
        for (const [proxyAddr, apps] of Object.entries(this.config.proxy_app_map)) {
            if (apps.some(app => appName.includes(app.toLowerCase()))) {
                const [host, port] = proxyAddr.split(':');
                return { host, port: parseInt(port) };
            }
        }
        return null;
    }

    handleClientConnection(clientSocket) {
        this.resources.addConnection(clientSocket);
        
        clientSocket.once('data', (data) => {
            const clientPort = clientSocket.remotePort;
            
            let appName = this.resources.getCachedAppName(clientPort);
            if (!appName) {
                appName = this.getAppNameByPort(clientPort);
                if (appName) {
                    this.resources.setCachedAppName(clientPort, appName);
                }
            }

            const targetProxy = appName ? this.getProxyByApp(appName) : null;

            if (!targetProxy) {
                this.handleDirectConnection(clientSocket, data, appName);
                return;
            }

            this.handleProxyConnection(clientSocket, data, targetProxy, appName);
        });

        clientSocket.on('close', () => {
            this.resources.removeConnection(clientSocket);
        });

        clientSocket.on('error', (err) => {
            this.logWarn({
                event: '客户端连接错误'
            }, err);
            this.resources.removeConnection(clientSocket);
        });
    }

    handleDirectConnection(clientSocket, data, appName) {
        const firstLine = data.toString().split('\n')[0];
        let host, port;

        if (firstLine.startsWith('CONNECT')) {
            const match = firstLine.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
            if (match) {
                [, host, port] = match;
            }
        } else {
            const match = firstLine.match(/^[A-Z]+\s+(?:https?:\/\/)?([^:\/\s]+):?(\d+)?/i);
            if (match) {
                [, host, port] = match;
                port = port || '80';
            }
        }

        if (host && port) {
            this.createDirectConnection(clientSocket, host, port, firstLine, appName, data);
        } else {
            this.logWarn({
                event: '解析失败',
                app: appName || '未知应用',
                data: firstLine
            });
            clientSocket.destroy();
        }
    }

    createDirectConnection(clientSocket, host, port, firstLine, appName, data) {
        this.logInfo({
            event: '透明代理',
            app: appName || '未知应用',
            target: `${host}:${port}`,
            mode: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
        });

        // 记录目标信息
        if (appName) {
            this.resources.recordAppTarget(appName, {
                host,
                port: parseInt(port),
                type: 'direct',
                protocol: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
            });
        }

        const directSocket = new net.Socket();
        directSocket.connect(parseInt(port), host, () => {
            this.logInfo({
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
            
            this.resources.addConnection(directSocket);
            
            directSocket.on('close', () => {
                this.logInfo({
                    event: '直连关闭',
                    app: appName || '未知应用',
                    target: `${host}:${port}`
                });
                this.resources.removeConnection(directSocket);
            });
        });

        directSocket.on('error', (err) => {
            this.logWarn({
                event: '直连错误',
                app: appName || '未知应用',
                target: `${host}:${port}`
            }, err);
            this.resources.removeConnection(directSocket);
            clientSocket.destroy();
        });
    }

    // 从HTTP请求数据中解析目标地址
    parseTargetFromData(data) {
        const firstLine = data.toString().split('\n')[0];
        let host, port;

        if (firstLine.startsWith('CONNECT')) {
            // HTTPS请求
            const match = firstLine.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
            if (match) {
                [, host, port] = match;
                return {
                    host,
                    port: parseInt(port),
                    protocol: 'HTTPS'
                };
            }
        } else {
            // HTTP请求
            const match = firstLine.match(/^[A-Z]+\s+(?:https?:\/\/)?([^:\/\s]+):?(\d+)?/i);
            if (match) {
                [, host, port] = match;
                port = port || '80';
                return {
                    host,
                    port: parseInt(port),
                    protocol: 'HTTP'
                };
            }
        }
        return null;
    }

    handleProxyConnection(clientSocket, data, targetProxy, appName) {
        const proxySocket = new net.Socket();
        
        // 解析实际的目标地址
        const targetInfo = this.parseTargetFromData(data);
        
        this.logInfo({
            event: '代理模式',
            app: appName || '未知应用',
            proxy: `${targetProxy.host}:${targetProxy.port}`,
            target: targetInfo ? `${targetInfo.host}:${targetInfo.port}` : '未知目标'
        });

        // 记录目标信息
        if (appName && targetInfo) {
            this.resources.recordAppTarget(appName, {
                host: targetInfo.host,
                port: targetInfo.port,
                type: 'proxy',
                protocol: targetInfo.protocol,
                via: `${targetProxy.host}:${targetProxy.port}` // 添加代理服务器信息
            });
        }

        proxySocket.connect(targetProxy.port, targetProxy.host, () => {
            this.logInfo({
                event: '代理连接成功',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            });

            proxySocket.write(data);
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
            
            this.resources.addConnection(proxySocket);
            
            proxySocket.on('close', () => {
                this.logInfo({
                    event: '代理连接关闭',
                    app: appName || '未知应用',
                    proxy: `${targetProxy.host}:${targetProxy.port}`
                });
                this.resources.removeConnection(proxySocket);
            });
        });

        proxySocket.on('error', (err) => {
            this.logWarn({
                event: '代理连接错误',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            }, err);
            this.resources.removeConnection(proxySocket);
            clientSocket.destroy();
        });
    }

    createServer() {
        this.server = net.createServer((clientSocket) => {
            this.handleClientConnection(clientSocket);
        });
        return this.server;
    }

    closeServer(callback) {
        if (this.server) {
            this.server.close(callback);
        }
    }

    shutdown() {
        if (this.resources.isShuttingDown) {
            return;
        }
        this.resources.isShuttingDown = true;
        this.resources.closeConnections();
    }

    forceShutdown() {
        this.resources.forceCloseConnections();
        this.resources.cleanup();
    }

    get connectionsCount() {
        return this.resources.connectionsCount;
    }
}

module.exports = ProxyServer; 