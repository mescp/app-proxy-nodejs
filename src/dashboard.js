const http = require('http');
const fs = require('fs');
const path = require('path');

class Dashboard {
    constructor(config, resourceManager, { logInfo, logWarn, logError }) {
        this.config = config;
        this.resourceManager = resourceManager;
        this.server = null;
        this.logInfo = logInfo;
        this.logWarn = logWarn;
        this.logError = logError;
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

    start() {
        if (!this.config.dashboard?.enabled) {
            this.logInfo({
                message: '[Dashboard] 未启用，跳过启动'
            });
            return;
        }

        this.server = http.createServer((req, res) => {
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
                    this.logInfo({
                        message: '[Dashboard] 页面访问',
                        path: '/'
                    });
                });
            } else if (req.url === '/api/cache') {
                // 提供缓存数据API
                try {
                    const response = {};
                    const keys = this.resourceManager.appCache.keys();
                    
                    keys.forEach(key => {
                        if (!key) return;  // 跳过无效的key
                        
                        try {
                            const appName = this.resourceManager.appCache.get(key);
                            const ttl = this.resourceManager.appCache.getTtl(key);
                            
                            response[key] = {
                                value: appName || '未知应用',
                                ttl: ttl || 0,
                                proxy: this.getProxyByApp(appName)
                            };
                        } catch (err) {
                            this.logWarn({
                                message: '[Dashboard] 缓存数据处理警告',
                                error: err.message,
                                key: key
                            });
                        }
                    });

                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify(response));
                    
                    //不打印缓存数据
                    // this.logInfo({
                    //     message: '[Dashboard] 缓存数据获取',
                    //     recordCount: Object.keys(response).length
                    // });
                    
                } catch (error) {
                    this.logError({
                        message: '[Dashboard] 缓存数据获取失败',
                        error: error.message
                    });
                    res.writeHead(500);
                    res.end('Error fetching cache data');
                }
            } else {
                this.logWarn({
                    message: '[Dashboard] 未知路径访问',
                    path: req.url
                });
                res.writeHead(404);
                res.end('Not found');
            }
        });

        const host = this.config.dashboard.host || '127.0.0.1';
        const port = this.config.dashboard.port || 8081;

        this.server.listen(port, host, () => {
            this.logInfo({
                message: '[Dashboard] 服务启动',
                address: `http://${host}:${port}`
            });
        });

        this.server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                this.logError({
                    message: '[Dashboard] 启动失败',
                    error: `端口 ${port} 已被占用`
                });
            } else {
                this.logError({
                    message: '[Dashboard] 服务错误',
                    error: error.message
                });
            }
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this.logInfo({
                message: '[Dashboard] 服务停止'
            });
        }
    }
}

module.exports = Dashboard;