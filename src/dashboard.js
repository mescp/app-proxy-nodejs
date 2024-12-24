const http = require('http');
const fs = require('fs');
const path = require('path');

class Dashboard {
    constructor(config, resourceManager) {
        this.config = config;
        this.resourceManager = resourceManager;
        this.server = null;
    }

    getProxyByApp(appName) {
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
            return;
        }

        this.server = http.createServer((req, res) => {
            if (req.url === '/') {
                // 提供HTML页面
                const htmlPath = path.join(__dirname, 'dashboard', 'index.html');
                fs.readFile(htmlPath, 'utf8', (err, content) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Error loading dashboard');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content);
                });
            } else if (req.url === '/api/cache') {
                // 提供缓存数据API
                const response = {};
                this.resourceManager.appCache.keys().forEach(key => {
                    const appName = this.resourceManager.appCache.get(key);
                    response[key] = {
                        value: appName,
                        ttl: this.resourceManager.appCache.getTtl(key),
                        proxy: this.getProxyByApp(appName)
                    };
                });

                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(response));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        const host = this.config.dashboard.host || '127.0.0.1';
        const port = this.config.dashboard.port || 8081;

        this.server.listen(port, host, () => {
            console.log(`Dashboard running at http://${host}:${port}`);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}

module.exports = Dashboard;