const http = require('http');
const fs = require('fs');
const path = require('path');

// 添加 MIME 类型映射
const MIME_TYPES = {
    '.css': 'text/css',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.html': 'text/html',
    '.js': 'application/javascript'
};

class Dashboard {
    constructor(config, resourceManager, { logInfo, logWarn, logError }) {
        this.config = config;
        this.resourceManager = resourceManager;
        this.server = null;
        this.logInfo = logInfo;
        this.logWarn = logWarn;
        this.logError = logError;
    }

    // 处理静态文件请求
    async handleStaticFile(req, res) {
        const staticPath = path.join(__dirname, 'dashboard', req.url);
        const ext = path.extname(staticPath);
        
        try {
            const data = await fs.promises.readFile(staticPath);
            res.writeHead(200, { 
                'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=86400' // 24小时缓存
            });
            res.end(data);
            return true;
        } catch (err) {
            return false;
        }
    }

    getProxyByApp(appName) {
        if (!appName || typeof appName !== 'string') {
            return '直连';
        }
        
        const proxyMap = this.config.proxy_app_map || {};
        for (const [proxyAddr, apps] of Object.entries(proxyMap)) {
            if (apps.some(app => appName.toLowerCase().includes(app.toLowerCase()))) {
                return proxyAddr;
            }
        }
        return '直连';
    }

    // 合并相同应用的连接信息
    mergeAppConnections(portConnections, appCache) {
        const appStats = new Map(); // 应用统计信息

        for (const [port, connections] of portConnections) {
            if (!port || connections.size === 0) continue;
            
            const appName = appCache.get(port);
            if (!appName) continue;

            // 标准化应用名称（移除可能的进程ID等）
            const normalizedName = this.normalizeAppName(appName);
            
            if (!appStats.has(normalizedName)) {
                appStats.set(normalizedName, {
                    name: normalizedName,
                    ports: new Set(),
                    totalConnections: 0,
                    idleConnections: 0,
                    totalIdleTime: 0,
                    proxy: this.getProxyByApp(appName)
                });
            }

            const stats = appStats.get(normalizedName);
            stats.ports.add(port);

            // 获取该端口的连接统计
            const portStats = this.resourceManager.getConnectionStats(port);
            if (portStats) {
                stats.totalConnections += portStats.total;
                stats.idleConnections += portStats.idle;
                stats.totalIdleTime += portStats.idle * portStats.avgIdleTime;
            }
        }

        return Array.from(appStats.values()).map(stats => ({
            name: stats.name,
            ports: Array.from(stats.ports),
            connections: stats.totalConnections,
            proxy: stats.proxy,
            status: stats.totalConnections > 0 ? '活动' : '断开',
            idleConnections: stats.idleConnections,
            avgIdleTime: stats.idleConnections > 0 
                ? Math.round(stats.totalIdleTime / stats.idleConnections / 1000) 
                : 0, // 转换为秒
            activeConnections: stats.totalConnections - stats.idleConnections
        }));
    }

    // 标准化应用名称
    normalizeAppName(appName) {
        // 移除进程ID等信息，保留主要应用名称
        return appName.toLowerCase()
            .replace(/\s+\(\d+\)$/, '')  // 移除末尾的进程ID
            .replace(/\s+helper.*$/, ' helper')  // 统一 helper 进程名称
            .trim();
    }

    start() {
        if (!this.config.dashboard?.enabled) {
            this.logInfo({
                message: '[Dashboard] 未启用，跳过启动'
            });
            return;
        }

        this.server = http.createServer(async (req, res) => {
            // 处理静态文件请求
            if (req.url.startsWith('/static/')) {
                const handled = await this.handleStaticFile(req, res);
                if (handled) return;
            }

            if (req.url === '/') {
                // 提供HTML页面
                const htmlPath = path.join(__dirname, 'dashboard', 'index.html');
                fs.readFile(htmlPath, 'utf8', (err, content) => {
                    if (err) {
                        this.logError({
                            message: '[Dashboard] 页面加载失败',
                            error: err.message
                        });
                        res.writeHead(500);
                        res.end('Error loading dashboard');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content);
                });
            } else if (req.url === '/api/cache') {
                // 提供缓存数据API
                try {
                    // 获取合并后的应用连接信息
                    const mergedData = this.mergeAppConnections(
                        this.resourceManager.portConnections,
                        this.resourceManager.appCache
                    );

                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify(mergedData));
                    
                } catch (error) {
                    this.logError({
                        message: '[Dashboard] 缓存数据获取失败',
                        error: error.message
                    });
                    res.writeHead(500);
                    res.end('Error fetching cache data');
                }
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        const { port = 8081, host = '127.0.0.1' } = this.config.dashboard || {};
        
        this.server.listen(port, host, () => {
            this.logInfo({
                message: '[Dashboard] 服务已启动',
                address: `http://${host}:${port}`
            });
        });

        this.server.on('error', (err) => {
            this.logError({
                message: '[Dashboard] 服务启动失败',
                error: err.message
            });
        });
    }

    stop() {
        if (this.server) {
            this.server.close(() => {
                this.logInfo({
                    message: '[Dashboard] 服务已停止'
                });
            });
        }
    }
}

module.exports = Dashboard;