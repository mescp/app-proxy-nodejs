const net = require('net');

class ProxyServer {
    constructor(config, { appCache, proxyManager, logInfo, logWarn, logError, activeConnections }) {
        this.config = config;
        this.appCache = appCache;
        this.proxyManager = proxyManager;
        this.logInfo = logInfo;
        this.logWarn = logWarn;
        this.logError = logError;
        this.activeConnections = activeConnections;
        this.server = null;
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
        this.activeConnections.add(clientSocket);
        
        clientSocket.once('data', (data) => {
            const clientPort = clientSocket.remotePort;
            
            let appName = this.appCache.get(clientPort);
            if (!appName) {
                appName = this.getAppNameByPort(clientPort);
                if (appName) {
                    this.appCache.set(clientPort, appName);
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
            this.activeConnections.delete(clientSocket);
        });

        clientSocket.on('error', (err) => {
            this.logWarn({
                event: '客户端连接错误'
            }, err);
            this.activeConnections.delete(clientSocket);
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
            this.createDirectConnection(clientSocket, host, port, firstLine, appName);
        } else {
            this.logWarn({
                event: '解析失败',
                app: appName || '未知应用',
                data: firstLine
            });
            clientSocket.destroy();
        }
    }

    createDirectConnection(clientSocket, host, port, firstLine, appName) {
        this.logInfo({
            event: '透明代理',
            app: appName || '未知应用',
            target: `${host}:${port}`,
            mode: firstLine.startsWith('CONNECT') ? 'HTTPS' : 'HTTP'
        });

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
            
            this.activeConnections.add(directSocket);
            
            directSocket.on('close', () => {
                this.logInfo({
                    event: '直连关闭',
                    app: appName || '未知应用',
                    target: `${host}:${port}`
                });
                this.activeConnections.delete(directSocket);
            });
        });

        directSocket.on('error', (err) => {
            this.logWarn({
                event: '直连错误',
                app: appName || '未知应用',
                target: `${host}:${port}`
            }, err);
            this.activeConnections.delete(directSocket);
            clientSocket.destroy();
        });
    }

    handleProxyConnection(clientSocket, data, targetProxy, appName) {
        const proxySocket = new net.Socket();
        
        this.logInfo({
            event: '代理模式',
            app: appName || '未知应用',
            proxy: `${targetProxy.host}:${targetProxy.port}`
        });

        proxySocket.connect(targetProxy.port, targetProxy.host, () => {
            this.logInfo({
                event: '代理连接成功',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            });

            proxySocket.write(data);
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
            
            this.activeConnections.add(proxySocket);
            
            proxySocket.on('close', () => {
                this.logInfo({
                    event: '代理连接关闭',
                    app: appName || '未知应用',
                    proxy: `${targetProxy.host}:${targetProxy.port}`
                });
                this.activeConnections.delete(proxySocket);
            });
        });

        proxySocket.on('error', (err) => {
            this.logWarn({
                event: '代理连接错误',
                app: appName || '未知应用',
                proxy: `${targetProxy.host}:${targetProxy.port}`
            }, err);
            this.activeConnections.delete(proxySocket);
            clientSocket.destroy();
        });
    }

    createServer() {
        this.server = net.createServer((clientSocket) => {
            this.handleClientConnection(clientSocket);
        });
        return this.server;
    }
}

module.exports = ProxyServer; 