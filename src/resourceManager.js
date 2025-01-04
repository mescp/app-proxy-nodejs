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

module.exports = ResourceManager; 