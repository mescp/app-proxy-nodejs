const { execSync } = require('child_process');

class ProxyManager {
    constructor(config, logger) {
        this.config = config;
        this.logInfo = logger.info;
        this.logError = logger.error;
    }

    getNetworkServices() {
        try {
            const output = execSync('networksetup -listallnetworkservices').toString();
            const excludedServices = new Set(this.config.server.excluded_services || []);
            return output.split('\n')
                .slice(1)
                .filter(service => 
                    service && 
                    !service.startsWith('*') && 
                    !excludedServices.has(service.trim())
                );
        } catch (error) {
            this.logError({
                event: '获取网络服务列表失败',
                error: error.message
            });
            return [];
        }
    }

    setSystemProxy(enable) {
        const services = this.getNetworkServices();
        const proxyHost = '127.0.0.1';
        
        if (services.length === 0) {
            this.logInfo({
                event: '系统代理设置',
                status: '没有可用的网络服务'
            });
            return;
        }
        
        for (const service of services) {
            try {
                if (enable) {
                    // 设置 HTTP 代理
                    execSync(`networksetup -setwebproxy "${service}" ${proxyHost} ${this.config.server.port}`);
                    execSync(`networksetup -setwebproxystate "${service}" on`);
                    
                    // 设置 HTTPS 代理
                    execSync(`networksetup -setsecurewebproxy "${service}" ${proxyHost} ${this.config.server.port}`);
                    execSync(`networksetup -setsecurewebproxystate "${service}" on`);
                    
                    this.logInfo({
                        event: '系统代理设置',
                        service: service,
                        status: '已启用',
                        proxy: `${proxyHost}:${this.config.server.port}`
                    });
                } else {
                    // 关闭 HTTP 代理
                    execSync(`networksetup -setwebproxystate "${service}" off`);
                    // 关闭 HTTPS 代理
                    execSync(`networksetup -setsecurewebproxystate "${service}" off`);
                    
                    this.logInfo({
                        event: '系统代理设置',
                        service: service,
                        status: '已禁用'
                    });
                }
            } catch (error) {
                this.logError({
                    event: '系统代理设置失败',
                    service: service,
                    error: error.message
                });
            }
        }
    }

    getAppNameByPort(port) {
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
            this.logError({
                event: '获取应用名称失败',
                error: error.message
            });
            return null;
        }
    }
}

module.exports = ProxyManager;
