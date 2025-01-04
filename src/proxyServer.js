const net = require('net');
const ResourceManager = require('./resourceManager');

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

        // 仅在 dashboard 启用时记录目标信息
        if (this.config?.dashboard?.enabled && appName) {
            this.resources.recordAppTarget(appName, {
                host,
                port: parseInt(port),
                type: 'direct',
                protocol: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
            }, false);
        }

        const directSocket = new net.Socket();
        directSocket.connect(parseInt(port), host, () => {
            this.logInfo({
                event: '直连成功',
                app: appName || '未知应用',
                target: `${host}:${port}`,
                mode: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
            });

            // 仅在 dashboard 启用时更新记录
            if (this.config?.dashboard?.enabled && appName) {
                this.resources.recordAppTarget(appName, {
                    host,
                    port: parseInt(port),
                    type: 'direct',
                    protocol: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
                }, true);
            }

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

            // 仅在 dashboard 启用时记录失败状态
            if (this.config?.dashboard?.enabled && appName) {
                this.resources.recordAppTarget(appName, {
                    host,
                    port: parseInt(port),
                    type: 'direct',
                    protocol: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
                }, false);
            }

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

        // 仅在 dashboard 启用时记录目标信息
        if (this.config?.dashboard?.enabled && appName && targetInfo) {
            this.resources.recordAppTarget(appName, {
                host: targetInfo.host,
                port: targetInfo.port,
                type: 'proxy',
                protocol: targetInfo.protocol,
                via: `${targetProxy.host}:${targetProxy.port}`
            }, false);
        }

        proxySocket.connect(targetProxy.port, targetProxy.host, () => {
            this.logInfo({
                event: '代理连接成功',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            });

            // 仅在 dashboard 启用时更新记录
            if (this.config?.dashboard?.enabled && appName && targetInfo) {
                this.resources.recordAppTarget(appName, {
                    host: targetInfo.host,
                    port: targetInfo.port,
                    type: 'proxy',
                    protocol: targetInfo.protocol,
                    via: `${targetProxy.host}:${targetProxy.port}`
                }, true);
            }

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

            // 仅在 dashboard 启用时记录失败状态
            if (this.config?.dashboard?.enabled && appName && targetInfo) {
                this.resources.recordAppTarget(appName, {
                    host: targetInfo.host,
                    port: targetInfo.port,
                    type: 'proxy',
                    protocol: targetInfo.protocol,
                    via: `${targetProxy.host}:${targetProxy.port}`
                }, false);
            }

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