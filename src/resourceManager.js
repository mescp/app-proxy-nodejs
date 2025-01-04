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
            stdTTL: 60*30,      // 5分钟后过期
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
                // 获取应用名称
                const appName = this.appCache.get(port);
                
                // 清理端口连接记录
                this.portConnections.delete(port);
                
                // 清理应用名称缓存
                this.appCache.del(port);
                
                // 如果这是应用的最后一个连接，清理目标记录
                if (appName) {
                    const hasOtherConnections = Array.from(this.portConnections.keys()).some(p => {
                        const otherAppName = this.appCache.get(p);
                        return otherAppName === appName;
                    });
                    
                    if (!hasOtherConnections) {
                        this.appTargetCache.del(appName);
                    }
                }
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
    recordAppTarget(appName, target, success = true) {
        if (!appName || !target) return;
        
        let targets = this.appTargetCache.get(appName) || new Set();
        const targetKey = JSON.stringify(target); // 用于排重的键
        
        // 移除相同目标的旧记录
        const existingTargets = Array.from(targets).map(t => JSON.parse(t));
        targets = new Set(existingTargets
            .filter(t => JSON.stringify(t.target) !== targetKey)
            .map(t => JSON.stringify(t)));
        
        // 添加新记录
        const targetWithStatus = {
            target,
            success,
            timestamp: Date.now()
        };
        targets.add(JSON.stringify(targetWithStatus));
        this.appTargetCache.set(appName, targets);
    }

    // 获取应用访问的所有远端目标
    getAppTargets(appName) {
        if (!appName) return [];
        const targets = this.appTargetCache.get(appName);
        if (!targets) return [];
        return Array.from(targets)
            .map(t => JSON.parse(t))
            .sort((a, b) => b.timestamp - a.timestamp); // 按时间戳降序排序
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

module.exports = ResourceManager; 